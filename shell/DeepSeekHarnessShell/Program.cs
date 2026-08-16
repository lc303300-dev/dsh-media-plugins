namespace DeepSeekHarnessShell;

static class Program
{
    [STAThread]
    static void Main()
    {
        using var mutex = new Mutex(true, "DeepSeekHarnessShell.SingleInstance", out var createdNew);
        if (!createdNew)
        {
            MessageBox.Show("DeepSeek Harness is already running. Use the tray icon to reopen it.", "DeepSeek Harness", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return;
        }

        ApplicationConfiguration.Initialize();
        Application.Run(new ShellForm());
    }    
}
