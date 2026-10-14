using System;
using System.Diagnostics;
using System.IO;
using System.Text;

namespace NomsodMcpBackground
{
    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            if (args == null || args.Length < 1)
                return 64;

            if (String.Equals(args[0], "--exec-wait", StringComparison.OrdinalIgnoreCase))
                return RunExecutable(args, true);

            if (String.Equals(args[0], "--exec-detach", StringComparison.OrdinalIgnoreCase))
                return RunExecutable(args, false);

            return RunPowerShellScript(args);
        }

        private static int RunPowerShellScript(string[] args)
        {
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
                "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File " +
                QuoteArgument(script) + " -Root " + QuoteArgument(root);

            return StartHidden(powershell, psArgs, root, true);
        }

        private static int RunExecutable(string[] args, bool wait)
        {
            // --exec-wait <working-directory> <executable> [arguments...]
            if (args.Length < 3)
                return 64;

            string root;
            string executable;

            try
            {
                root = Path.GetFullPath(args[1]);
                executable = Path.GetFullPath(args[2]);
            }
            catch
            {
                return 65;
            }

            if (!Directory.Exists(root) || !File.Exists(executable))
                return 66;

            string childArgs = JoinArguments(args, 3);
            return StartHidden(executable, childArgs, root, wait);
        }

        private static int StartHidden(
            string executable,
            string arguments,
            string workingDirectory,
            bool wait
        )
        {
            var info = new ProcessStartInfo
            {
                FileName = executable,
                Arguments = arguments,
                WorkingDirectory = workingDirectory,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };

            try
            {
                var child = Process.Start(info);
                if (child == null)
                    return 70;

                if (!wait)
                {
                    child.Dispose();
                    return 0;
                }

                using (child)
                {
                    child.WaitForExit();
                    return child.ExitCode;
                }
            }
            catch
            {
                return 70;
            }
        }

        private static string JoinArguments(string[] args, int start)
        {
            var result = new StringBuilder();

            for (int i = start; i < args.Length; i++)
            {
                if (result.Length > 0)
                    result.Append(' ');

                result.Append(QuoteArgument(args[i]));
            }

            return result.ToString();
        }

        private static string QuoteArgument(string value)
        {
            if (value == null)
                return "\"\"";

            if (value.Length == 0)
                return "\"\"";

            bool needsQuotes = false;
            for (int i = 0; i < value.Length; i++)
            {
                char ch = value[i];
                if (Char.IsWhiteSpace(ch) || ch == '"')
                {
                    needsQuotes = true;
                    break;
                }
            }

            if (!needsQuotes)
                return value;

            var result = new StringBuilder();
            result.Append('"');

            int backslashes = 0;
            for (int i = 0; i < value.Length; i++)
            {
                char ch = value[i];

                if (ch == '\\')
                {
                    backslashes++;
                    continue;
                }

                if (ch == '"')
                {
                    result.Append('\\', backslashes * 2 + 1);
                    result.Append('"');
                    backslashes = 0;
                    continue;
                }

                if (backslashes > 0)
                {
                    result.Append('\\', backslashes);
                    backslashes = 0;
                }

                result.Append(ch);
            }

            if (backslashes > 0)
                result.Append('\\', backslashes * 2);

            result.Append('"');
            return result.ToString();
        }
    }
}
