using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace DeepSeekHarnessShell;

public sealed class ShellForm : Form
{
    private static readonly int[] CandidatePorts = [9785, 9786, 9787, 9788, 9789];

    private readonly string root;
    private readonly string privateDir;
    private readonly Icon appIcon;
    private readonly NotifyIcon trayIcon;
    private readonly WebView2 webView;
    private readonly Label loadingLabel;
    private Process? serverProcess;
    private bool exitRequested;
    private bool recoveryAttempted;
    private Uri? appUrl;
    private int? serverPort;
    private string? serverErrorLog;

    public ShellForm()
    {
        root = ResolveRoot();
        privateDir = Path.Combine(root, "scripts", "local", ".shell-private");
        Directory.CreateDirectory(privateDir);
        appIcon = LoadAppIcon();

        Text = "DeepSeek Harness";
        Icon = appIcon;
        Width = 1440;
        Height = 960;
        MinimumSize = new Size(960, 640);
        StartPosition = FormStartPosition.CenterScreen;

        webView = new WebView2 { Dock = DockStyle.Fill };
        Controls.Add(webView);

        loadingLabel = new Label
        {
            Dock = DockStyle.Fill,
            Text = "Starting DeepSeek Harness...",
            TextAlign = ContentAlignment.MiddleCenter,
            BackColor = Color.FromArgb(18, 18, 18),
            ForeColor = Color.White
        };
        Controls.Add(loadingLabel);
        loadingLabel.BringToFront();

        trayIcon = new NotifyIcon
        {
            Icon = appIcon,
            Text = "DeepSeek Harness",
            Visible = true,
            ContextMenuStrip = BuildTrayMenu()
        };
        trayIcon.DoubleClick += (_, _) => ShowWindow();

        FormClosing += OnFormClosing;
        webView.CoreWebView2InitializationCompleted += (_, args) =>
        {
            if (!args.IsSuccess)
            {
                loadingLabel.Text = $"WebView2 failed to initialize: {args.InitializationException?.Message}";
                loadingLabel.Show();
                loadingLabel.BringToFront();
            }
        };
        Shown += async (_, _) => await StartAsync();
    }

    private static string ResolveRoot()
    {
        var configured = Environment.GetEnvironmentVariable("DEEPSEEK_HARNESS_ROOT");
        if (!string.IsNullOrWhiteSpace(configured) && Directory.Exists(configured))
        {
            return configured;
        }

        var current = AppContext.BaseDirectory;
        for (var i = 0; i < 8; i++)
        {
            if (File.Exists(Path.Combine(current, "package.json"))
                && File.Exists(Path.Combine(current, "apps", "cli", "src", "bin.ts")))
            {
                return current;
            }

            var parent = Directory.GetParent(current);
            if (parent is null)
            {
                break;
            }

            current = parent.FullName;
        }

        const string fallback = @"D:\AI\DeepseekHarness";
        if (Directory.Exists(fallback))
        {
            return fallback;
        }

        throw new DirectoryNotFoundException("DeepSeek Harness root was not found.");
    }

    private static Icon LoadAppIcon()
    {
        var iconPath = Path.Combine(AppContext.BaseDirectory, "Assets", "DeepSeekHarness.ico");
        if (File.Exists(iconPath))
        {
            return new Icon(iconPath);
        }

        return SystemIcons.Application;
    }

    private ContextMenuStrip BuildTrayMenu()
    {
        var menu = new ContextMenuStrip();
        menu.Items.Add("Open", null, (_, _) => ShowWindow());
        menu.Items.Add("Reload", null, (_, _) => webView.CoreWebView2?.Reload());
        menu.Items.Add("Copy URL", null, (_, _) =>
        {
            if (appUrl is not null)
            {
                Clipboard.SetText(appUrl.ToString());
            }
        });
        menu.Items.Add(new ToolStripSeparator());
        menu.Items.Add("Exit", null, (_, _) =>
        {
            exitRequested = true;
            Close();
        });
        return menu;
    }

    private async Task StartAsync()
    {
        try
        {
            await PrepareRuntimeAsync(force: false);
            appUrl = await EnsureServerAsync();
            serverPort = appUrl.Port;
            await Task.Delay(1000);

            var webViewUserData = Path.Combine(privateDir, "webview2-profile");
            var environment = await CoreWebView2Environment.CreateAsync(null, webViewUserData);
            await webView.EnsureCoreWebView2Async(environment);
            webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
            webView.CoreWebView2.Settings.AreDevToolsEnabled = true;
            webView.CoreWebView2.NavigationCompleted += async (_, args) =>
            {
                if (args.IsSuccess)
                {
                    loadingLabel.Hide();
                    webView.BringToFront();
                    return;
                }

                if (!recoveryAttempted && serverProcess?.HasExited == true)
                {
                    recoveryAttempted = true;
                    loadingLabel.Text = "Backend stopped. Repairing and retrying once...";
                    loadingLabel.Show();
                    loadingLabel.BringToFront();
                    try
                    {
                        await PrepareRuntimeAsync(force: true);
                        appUrl = await EnsureServerAsync();
                        serverPort = appUrl.Port;
                        webView.Source = appUrl;
                        return;
                    }
                    catch (Exception ex)
                    {
                        loadingLabel.Text = FormatFailure(ex);
                        return;
                    }
                }

                loadingLabel.Text = FormatFailure(new InvalidOperationException($"WebView error: {args.WebErrorStatus}"));
                loadingLabel.Show();
                loadingLabel.BringToFront();
            };
            // Keep all navigation inside the native shell. In particular, do
            // not forward startup-triggered target="_blank" requests to the
            // system browser, which would create a second UI window.
            webView.CoreWebView2.NewWindowRequested += (_, args) =>
            {
                args.Handled = true;
            };
            webView.Source = appUrl;
        }
        catch (Exception ex)
        {
            loadingLabel.Text = FormatFailure(ex);
            loadingLabel.Show();
            loadingLabel.BringToFront();
            MessageBox.Show(this, FormatFailure(ex), "DeepSeek Harness failed to start", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private async Task PrepareRuntimeAsync(bool force)
    {
        var lockfile = Path.Combine(root, "pnpm-lock.yaml");
        var packageFile = Path.Combine(root, "package.json");
        if (!File.Exists(lockfile) || !File.Exists(packageFile))
        {
            throw new InvalidOperationException("Repository metadata is incomplete: package.json or pnpm-lock.yaml is missing.");
        }

        var stateFile = Path.Combine(privateDir, "runtime-state.txt");
        var lockHash = Convert.ToHexString(SHA256.HashData(await File.ReadAllBytesAsync(lockfile)));
        var revision = await ReadProcessOutputAsync("git.exe", ["rev-parse", "HEAD"], root, TimeSpan.FromSeconds(10));
        var expectedState = $"lock={lockHash}\nrevision={revision.Trim()}\n";
        var previousState = File.Exists(stateFile) ? await File.ReadAllTextAsync(stateFile) : string.Empty;
        var installedLockfile = Path.Combine(root, "node_modules", ".pnpm", "lock.yaml");
        var requiredArtifacts = new[]
        {
            Path.Combine(root, "packages", "context", "session-reference", "lib", "typert.host.js"),
            Path.Combine(root, "packages", "client", "ui-renderer", "lib", "client.js"),
            Path.Combine(root, "packages", "client", "ui-brand-official", "lib", "client.js"),
            Path.Combine(root, "packages", "client", "ui-attachment", "lib", "client.js"),
            Path.Combine(root, "packages", "client", "ui-reference", "lib", "client.js")
        };

        var installNeeded = force || !File.Exists(installedLockfile);
        var buildNeeded = force || !string.Equals(previousState, expectedState, StringComparison.Ordinal)
            || requiredArtifacts.Any(path => !File.Exists(path));
        if (!installNeeded && !buildNeeded)
        {
            return;
        }

        Directory.CreateDirectory(Path.Combine(root, ".codex-image-private", "logs"));
        if (installNeeded || !string.Equals(previousState, expectedState, StringComparison.Ordinal))
        {
            loadingLabel.Text = "Repository changed. Synchronizing dependencies...";
            await RunMaintenanceAsync("install", "pnpm install --frozen-lockfile");
        }

        loadingLabel.Text = "Building updated DeepSeek Harness components...";
        await RunMaintenanceAsync("build", "pnpm run build");
        await WriteAtomicAsync(stateFile, expectedState);
        loadingLabel.Text = "Starting DeepSeek Harness...";
    }

    private async Task RunMaintenanceAsync(string name, string command)
    {
        var logDir = Path.Combine(root, ".codex-image-private", "logs");
        var logPath = Path.Combine(logDir, $"shell-{name}-{DateTime.Now:yyyyMMdd-HHmmss}.log");
        var startInfo = new ProcessStartInfo
        {
            FileName = "cmd.exe",
            WorkingDirectory = root,
            CreateNoWindow = true,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        startInfo.ArgumentList.Add("/d");
        startInfo.ArgumentList.Add("/s");
        startInfo.ArgumentList.Add("/c");
        startInfo.ArgumentList.Add(command);
        startInfo.Environment["CI"] = "true";

        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException($"Failed to start maintenance command: {command}");
        var stdout = process.StandardOutput.ReadToEndAsync();
        var stderr = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        var output = await stdout + await stderr;
        await File.WriteAllTextAsync(logPath, output, Encoding.UTF8);
        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException($"Automatic {name} failed (exit {process.ExitCode}).\n{Tail(output, 14)}\nFull log: {logPath}");
        }
    }

    private static async Task<string> ReadProcessOutputAsync(string fileName, string[] arguments, string workingDirectory, TimeSpan timeout)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = fileName,
            WorkingDirectory = workingDirectory,
            CreateNoWindow = true,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };
        foreach (var argument in arguments) startInfo.ArgumentList.Add(argument);
        using var process = Process.Start(startInfo)
            ?? throw new InvalidOperationException($"Failed to start {fileName}.");
        using var cts = new CancellationTokenSource(timeout);
        await process.WaitForExitAsync(cts.Token);
        var output = await process.StandardOutput.ReadToEndAsync();
        if (process.ExitCode != 0)
        {
            throw new InvalidOperationException($"{fileName} exited with code {process.ExitCode}: {await process.StandardError.ReadToEndAsync()}");
        }
        return output;
    }

    private static async Task WriteAtomicAsync(string path, string content)
    {
        var temporary = path + ".tmp";
        await File.WriteAllTextAsync(temporary, content, Encoding.UTF8);
        File.Move(temporary, path, overwrite: true);
    }

    private async Task<Uri> EnsureServerAsync()
    {
        foreach (var port in CandidatePorts)
        {
            var uri = new Uri($"http://127.0.0.1:{port}/");
            if (await IsHttpOkAsync(uri))
            {
                return uri;
            }

            if (CanListen(port))
            {
                return await StartServerAsync(port);
            }
        }

        throw new InvalidOperationException($"No available port found in: {string.Join(", ", CandidatePorts)}");
    }

    private async Task<Uri> StartServerAsync(int port)
    {
        var logDir = Path.Combine(root, ".codex-image-private", "logs");
        Directory.CreateDirectory(logDir);
        var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
        var stdout = Path.Combine(logDir, $"dsh-web-{port}-{stamp}.out.log");
        var stderr = Path.Combine(logDir, $"dsh-web-{port}-{stamp}.err.log");
        serverErrorLog = stderr;

        serverProcess = Process.Start(new ProcessStartInfo
        {
            FileName = "node.exe",
            Arguments = $"--import tsx/esm apps/cli/src/bin.ts web --host 127.0.0.1 --port {port} --no-open",
            WorkingDirectory = root,
            CreateNoWindow = true,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        });

        if (serverProcess is null)
        {
            throw new InvalidOperationException("Failed to launch node.exe.");
        }

        _ = Task.Run(async () => await RedirectAsync(serverProcess.StandardOutput, stdout));
        _ = Task.Run(async () => await RedirectAsync(serverProcess.StandardError, stderr));

        var uri = new Uri($"http://127.0.0.1:{port}/");
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(45));
        while (!cts.IsCancellationRequested)
        {
            if (serverProcess.HasExited)
            {
                await Task.Delay(250);
                var detail = File.Exists(stderr) ? Tail(await File.ReadAllTextAsync(stderr), 18) : "No backend error log was produced.";
                throw new InvalidOperationException($"Backend exited before becoming ready.\n{detail}\nFull log: {stderr}");
            }

            if (await IsHttpOkAsync(uri))
            {
                return uri;
            }

            await Task.Delay(500, cts.Token).ContinueWith(_ => { });
        }

        throw new TimeoutException($"DeepSeek Harness did not become ready at {uri}. Check logs in {logDir}.");
    }

    private static async Task RedirectAsync(StreamReader reader, string path)
    {
        await using var stream = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
        await using var writer = new StreamWriter(stream);
        while (await reader.ReadLineAsync() is { } line)
        {
            await writer.WriteLineAsync(line);
            await writer.FlushAsync();
        }
    }

    private static bool CanListen(int port)
    {
        var listener = new TcpListener(IPAddress.Parse("127.0.0.1"), port);
        try
        {
            listener.Start();
            return true;
        }
        catch
        {
            return false;
        }
        finally
        {
            listener.Stop();
        }
    }

    private static async Task<bool> IsHttpOkAsync(Uri uri)
    {
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
            using var response = await client.GetAsync(uri);
            return (int)response.StatusCode is >= 200 and < 500;
        }
        catch
        {
            return false;
        }
    }

    private string FormatFailure(Exception exception)
    {
        var detail = exception.Message;
        if (serverProcess?.HasExited == true && serverErrorLog is not null && File.Exists(serverErrorLog))
        {
            try
            {
                detail += $"\n\nBackend log:\n{Tail(File.ReadAllText(serverErrorLog), 12)}";
            }
            catch (IOException)
            {
                // The log writer may still be flushing; the original exception remains useful.
            }
        }
        return $"DeepSeek Harness could not start.\n\n{detail}";
    }

    private static string Tail(string value, int lineCount)
    {
        var lines = value.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries);
        return string.Join(Environment.NewLine, lines.TakeLast(lineCount));
    }

    private void ShowWindow()
    {
        Show();
        WindowState = FormWindowState.Normal;
        Activate();
    }

    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        if (!exitRequested)
        {
            e.Cancel = true;
            Hide();
            return;
        }

        trayIcon.Visible = false;
        trayIcon.Dispose();
        appIcon.Dispose();

        if (serverProcess is not null && !serverProcess.HasExited)
        {
            try
            {
                serverProcess.Kill(entireProcessTree: true);
            }
            catch
            {
                // The server may have exited between the HasExited check and Kill.
            }
        }

        if (serverPort is { } port)
        {
            KillProcessesListeningOnPort(port);
        }
    }

    private static void KillProcessesListeningOnPort(int port)
    {
        foreach (var processId in GetProcessIdsListeningOnPort(port))
        {
            try
            {
                using var process = Process.GetProcessById(processId);
                var name = process.ProcessName;
                if (!name.Contains("node", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                process.Kill(entireProcessTree: true);
            }
            catch
            {
                // The process may have exited or may not be accessible anymore.
            }
        }
    }

    private static IEnumerable<int> GetProcessIdsListeningOnPort(int port)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = "netstat.exe",
            Arguments = "-ano -p tcp",
            CreateNoWindow = true,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true
        };

        using var process = Process.Start(startInfo);
        if (process is null)
        {
            yield break;
        }

        var output = process.StandardOutput.ReadToEnd();
        process.WaitForExit(5000);

        foreach (var line in output.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries))
        {
            var parts = line.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            if (parts.Length < 5 || !parts[0].Equals("TCP", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (!parts[1].EndsWith(":" + port.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal))
            {
                continue;
            }

            if (!parts[3].Equals("LISTENING", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            if (int.TryParse(parts[4], NumberStyles.None, CultureInfo.InvariantCulture, out var processId))
            {
                yield return processId;
            }
        }
    }
}
