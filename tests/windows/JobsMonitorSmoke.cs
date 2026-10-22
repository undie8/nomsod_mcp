// Compile with NomsodMcpControl.cs and /main:JobsMonitorSmoke; run on Windows STA.
using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Reflection;
using System.Runtime.Serialization;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static class JobsMonitorSmoke
{
    private static readonly Type Context = typeof(NomsodMcpControl.NomsodApplicationContext);
    private const BindingFlags PrivateStatic = BindingFlags.NonPublic | BindingFlags.Static;
    private const long Start = 1792713600000L;
    private static volatile string response;
    private static Exception failure;

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new Exception(message);
    }

    private static string Job(string id, long timestamp)
    {
        return "{\"jobId\":\"" + id + "\",\"startedAt\":" + timestamp +
            ",\"status\":\"completed\",\"command\":\"test\",\"durationMs\":12,\"stdoutTail\":\"output-" + id + "\"}";
    }

    private static string Fixture(bool refreshed)
    {
        return "{\"jobs\":[" + Job("old", Start) + "," + Job("new", Start + 2000) +
            "," + Job("middle", Start + 1000) + "," + Job("unknown", 0) +
            (refreshed ? "," + Job("newest", Start + 3000) : "") + "]}";
    }

    private static Control Find(Control parent, Type type, string text)
    {
        foreach (Control child in parent.Controls)
        {
            if (type.IsInstanceOfType(child) && (text == null || child.Text == text)) return child;
            Control found = Find(child, type, text);
            if (found != null) return found;
        }
        return null;
    }

    [STAThread]
    public static int Main(string[] args)
    {
        try
        {
            IList jobs = (IList)Context.GetMethod("ParseJobs", PrivateStatic).Invoke(null, new object[] { Fixture(false) });
            Require(jobs.Count == 4, "All fixture jobs must be parsed");
            Require((string)jobs[0].GetType().GetProperty("JobId").GetValue(jobs[0], null) == "new", "Newest job must be first");
            Require((string)jobs[3].GetType().GetProperty("JobId").GetValue(jobs[3], null) == "unknown", "Missing time must sort last");
            IList missing = (IList)Context.GetMethod("ParseJobs", PrivateStatic).Invoke(null,
                new object[] { "{\"jobs\":[{\"jobId\":\"missing\"}]}" });
            Require((long)missing[0].GetType().GetProperty("StartedAt").GetValue(missing[0], null) == 0, "Missing timestamp must default to zero");
            if (args.Length > 0 && args[0] == "parse")
            {
                Console.WriteLine("PASS: timestamps parsed and rows sorted newest first");
                return 0;
            }

            MethodInfo format = Context.GetMethod("FormatStartedAt", PrivateStatic);
            foreach (long invalid in new long[] { 0, -1, Int64.MaxValue })
                Require((string)format.Invoke(null, new object[] { invalid }) == "-", "Invalid timestamps must show a dash");

            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            int port = ((IPEndPoint)listener.LocalEndpoint).Port;
            response = Fixture(false);
            var server = new Thread(delegate()
            {
                try
                {
                    while (true)
                    {
                        using (TcpClient client = listener.AcceptTcpClient())
                        using (NetworkStream stream = client.GetStream())
                        {
                            var reader = new StreamReader(stream, Encoding.ASCII, false, 1024, true);
                            string line;
                            do { line = reader.ReadLine(); } while (!String.IsNullOrEmpty(line));
                            byte[] payload = Encoding.UTF8.GetBytes(response);
                            byte[] header = Encoding.ASCII.GetBytes("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: " + payload.Length + "\r\nConnection: close\r\n\r\n");
                            stream.Write(header, 0, header.Length);
                            stream.Write(payload, 0, payload.Length);
                        }
                    }
                }
                catch (SocketException) { }
            });
            server.IsBackground = true;
            server.Start();

            Application.EnableVisualStyles();
            object context = FormatterServices.GetUninitializedObject(Context);
            Context.GetField("env", BindingFlags.NonPublic | BindingFlags.Instance).SetValue(context,
                new Dictionary<string, string> { { "NOMSOD_AGENT_GUARDIAN_HEALTH_PORT", port.ToString() } });
            int phase = 0;
            DateTime deadline = DateTime.UtcNow.AddSeconds(8);
            using (var timer = new System.Windows.Forms.Timer { Interval = 100 })
            {
                timer.Tick += delegate
                {
                    if (Application.OpenForms.Count == 0) return;
                    Form form = Application.OpenForms[0];
                    try
                    {
                        Require(DateTime.UtcNow < deadline, "Monitor refresh timed out");
                        var list = (ListView)Find(form, typeof(ListView), null);
                        var output = (TextBox)Find(form, typeof(TextBox), null);
                        if (phase == 0)
                        {
                            Require(list.Columns[0].Text == "Started", "Started column must be first");
                            Require(list.Items.Count == 4 && (string)list.Items[0].Tag == "new", "Rendered order must be newest first");
                            string expected = new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(Start + 2000).ToLocalTime().ToString("dd/MM/yyyy HH:mm:ss", System.Globalization.CultureInfo.InvariantCulture);
                            Require(list.Items[0].Text == expected, "Started cell must show local date and time");
                            Require(list.Items[3].Text == "-", "Missing timestamp must show a dash");
                            list.Items[0].Selected = false;
                            list.Items[2].Selected = true;
                            Require(output.Text == "output-old", "Selected row must show its own output");
                            response = Fixture(true);
                            phase++;
                        }
                        else if (phase == 1)
                        {
                            if (list.Items.Count == 4) return;
                            Require(list.Items.Count == 5 && (string)list.Items[0].Tag == "newest", "Refresh must insert newest at top");
                            Require(list.SelectedItems.Count == 1 && (string)list.SelectedItems[0].Tag == "old", "Refresh must preserve selected job");
                            Require(output.Text == "output-old", "Refresh must preserve selected output");
                            ((CheckBox)Find(form, typeof(CheckBox), "Auto-refresh (1s)")).Checked = false;
                            response = "{\"jobs\":[]}";
                            ((Button)Find(form, typeof(Button), "Refresh")).PerformClick();
                            phase++;
                        }
                        else
                        {
                            Require(list.Items.Count == 0 && list.SelectedItems.Count == 0, "Empty refresh must clear rows and selection");
                            Require(output.Text == "", "Empty refresh must clear stale output");
                            timer.Stop();
                            form.Close();
                        }
                    }
                    catch (Exception ex) { failure = ex; timer.Stop(); form.Close(); }
                };
                timer.Start();
                try { Context.GetMethod("ShowJobsMonitorForm", BindingFlags.NonPublic | BindingFlags.Instance).Invoke(context, null); }
                finally { listener.Stop(); }
            }
            if (failure != null) throw failure;
            Require(phase == 2, "WinForms verification must execute");
            Console.WriteLine("PASS: HTTP -> parser -> WinForms order/local time -> auto-refresh preserves selection/output -> empty manual refresh");
            return 0;
        }
        catch (Exception ex) { Console.Error.WriteLine(ex.Message); return 1; }
    }
}
