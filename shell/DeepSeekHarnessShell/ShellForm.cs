using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace DeepSeekHarnessShell;

public sealed class ShellForm : Form
{
    private static readonly int[] CandidatePorts = [9785, 9786, 9787, 9788, 9789];

    private readonly string? root;
    private readonly string privateDir;
    private readonly Icon appIcon;
    private readonly NotifyIcon trayIcon;
    private readonly WebView2 webView;
    private readonly Label loadingLabel;
    private Process? serverProcess;
    private bool exitRequested;
    private Uri? appUrl;
    private int? serverPort;

    public ShellForm()
    {
        root = ResolveRoot();
        privateDir = ResolvePrivateDir(root);
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

    /// <summary>
    /// Resolve a DeepSeek Harness SOURCE checkout (the dev-only launch path) by
    /// walking up from the executable. Returns null when no source tree is
    /// present — the packaged shell then launches the installed <c>dsh</c> CLI
    /// instead, so a new machine needs only <c>@deepseek-ai/dsh</c>, not the
    /// monorepo.
    /// </summary>
    private static string? ResolveRoot()
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

        return null;
    }

    /// <summary>
    /// Shell-private runtime root: beside the dev checkout when one is present,
    /// otherwise under the user's LocalApplicationData (WebView2 profile + logs).
    /// </summary>
    private static string ResolvePrivateDir(string? root)
    {
        if (root is not null)
        {
            return Path.Combine(root, "scripts", "local", ".shell-private");
        }

        return Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "DeepSeekHarnessShell");
    }

    /// <summary>
    /// The <c>dsh</c> launcher word used in packaged mode, overridable via
    /// <c>DSH_WEB_COMMAND</c> for a custom binary or wrapper.
    /// </summary>
    private static string DshWebCommand()
    {
        var configured = Environment.GetEnvironmentVariable("DSH_WEB_COMMAND");
        return string.IsNullOrWhiteSpace(configured) ? "dsh" : configured.Trim();
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
            appUrl = await EnsureServerAsync();
            serverPort = appUrl.Port;
            await Task.Delay(1000);

            var webViewUserData = Path.Combine(privateDir, "webview2-profile");
            var environment = await CoreWebView2Environment.CreateAsync(null, webViewUserData);
            await webView.EnsureCoreWebView2Async(environment);
            webView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = true;
            webView.CoreWebView2.Settings.AreDevToolsEnabled = true;
            webView.CoreWebView2.NavigationCompleted += (_, args) =>
            {
                if (args.IsSuccess)
                {
                    loadingLabel.Hide();
                    webView.BringToFront();
                    return;
                }

                loadingLabel.Text = $"DeepSeek Harness failed to load: {args.WebErrorStatus}";
                loadingLabel.Show();
                loadingLabel.BringToFront();
            };
            // External hyperlinks render with target="_blank" (web search
            // citations, URL-promoted inline code, Web blocks). WebView2 has no
            // window chrome for those, so an unhandled NewWindowRequested leaves
            // every such link dead. Route browser-scheme requests to the system
            // default browser instead; anything else stays inert.
            webView.CoreWebView2.NewWindowRequested += (_, args) =>
            {
                args.Handled = true;
                var uri = args.Uri;
                if (string.IsNullOrWhiteSpace(uri)) return;
                if (!(uri.StartsWith("http://", StringComparison.OrdinalIgnoreCase)
                    || uri.StartsWith("https://", StringComparison.OrdinalIgnoreCase)
                    || uri.StartsWith("mailto:", StringComparison.OrdinalIgnoreCase)))
                {
                    return;
                }
                try
                {
                    Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true });
                }
                catch
                {
                    // No default browser (or a broken association): leave the
                    // link inert rather than crashing the shell.
                }
            };
            webView.Source = appUrl;
        }
        catch (Exception ex)
        {
            MessageBox.Show(this, ex.Message, "DeepSeek Harness failed to start", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
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
        var logDir = Path.Combine(privateDir, "logs");
        Directory.CreateDirectory(logDir);
        var stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss");
        var stdout = Path.Combine(logDir, $"dsh-web-{port}-{stamp}.out.log");
        var stderr = Path.Combine(logDir, $"dsh-web-{port}-{stamp}.err.log");

        // Dev mode (a source checkout is reachable): run the monorepo CLI from
        // source. Packaged mode (no source tree): run the installed `dsh` CLI
        // through cmd.exe so the npm `.cmd` shim resolves like a shell would.
        var startInfo = root is null
            ? new ProcessStartInfo
            {
                FileName = "cmd.exe",
                Arguments = $"/c {DshWebCommand()} web --host 127.0.0.1 --port {port}",
                WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            }
            : new ProcessStartInfo
            {
                FileName = "node.exe",
                Arguments = $"--import tsx/esm apps/cli/src/bin.ts web --host 127.0.0.1 --port {port}",
                WorkingDirectory = root,
                CreateNoWindow = true,
                UseShellExecute = false,
                RedirectStandardOutput = true,
                RedirectStandardError = true
            };

        serverProcess = Process.Start(startInfo);

        if (serverProcess is null)
        {
            throw new InvalidOperationException(root is null
                ? "Failed to launch dsh web. Is @deepseek-ai/dsh installed (dsh in PATH)?"
                : "Failed to launch node.exe.");
        }

        _ = Task.Run(async () => await RedirectAsync(serverProcess.StandardOutput, stdout));
        _ = Task.Run(async () => await RedirectAsync(serverProcess.StandardError, stderr));

        var uri = new Uri($"http://127.0.0.1:{port}/");
        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(45));
        while (!cts.IsCancellationRequested)
        {
            if (serverProcess.HasExited)
            {
                throw new InvalidOperationException($"DeepSeek Harness exited before becoming ready. Check logs in {logDir}.");
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
