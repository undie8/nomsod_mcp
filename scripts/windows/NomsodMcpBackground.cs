using System;
using System.Diagnostics;
using System.IO;

namespace NomsodMcpBackground
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            if (args == null || args.Length < 1)
                return 64;

            string script = Path.GetFullPath(args[0]);
            string root = args.Length >= 2
                ? Path.GetFullPath(args[1])
                : Path.GetDirectoryName(script) ?? Environment.CurrentDirectory;

            if (!File.Exists(script))
                return 66;

            string powershell = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.Windows),
                @"System32\WindowsPowerShell\v1.0\powershell.exe"
            );

            string psArgs =
                "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " +
                Quote(script) + " -Root " + Quote(root);

            var info = new ProcessStartInfo
            {
                FileName = powershell,
                Arguments = psArgs,
                WorkingDirectory = root,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };

            try
            {
                using (var child = Process.Start(info))
                {
                    if (child == null)
                        return 70;

                    child.WaitForExit();
                    return child.ExitCode;
                }
            }
            catch
            {
                return 70;
            }
        }

        private static string Quote(string value)
        {
            return "\"" + value.Replace("\"", "\\\"") + "\"";
        }
    }
}
