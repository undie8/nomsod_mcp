using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Text.RegularExpressions;
using System.Security.Cryptography;
using System.Windows.Forms;

namespace NomsodMcpControl
{
    internal sealed class NomsodApplicationContext : ApplicationContext
    {
        private readonly string root;
        private readonly NotifyIcon tray;
        private readonly Timer timer;
        private readonly ToolStripMenuItem statusItem;
        private readonly ToolStripMenuItem deviceItem;
        private readonly ToolStripMenuItem gatewayItem;
        private readonly ToolStripMenuItem agentRestartItem;
        private readonly ToolStripMenuItem supervisorRestartItem;
        private readonly Icon appIcon;
        private Dictionary<string, string> env = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        public NomsodApplicationContext(string projectRoot)
        {
            root = projectRoot;
            appIcon = Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Application;

            tray = new NotifyIcon();
            tray.Icon = appIcon;
            tray.Text = "Nomsod MCP Control";
            tray.Visible = true;

            var menu = new ContextMenuStrip();
            menu.Font = new Font("Segoe UI", 9.5f);

            var header = new ToolStripMenuItem("Nomsod MCP v" + GetVersion());
            header.Enabled = false;
            header.Font = new Font("Segoe UI", 9.5f, FontStyle.Bold);
            menu.Items.Add(header);

            statusItem = new ToolStripMenuItem("Status: checking...");
            statusItem.Enabled = false;
            menu.Items.Add(statusItem);

            deviceItem = new ToolStripMenuItem("Device: checking...");
            deviceItem.Enabled = false;
            menu.Items.Add(deviceItem);

            gatewayItem = new ToolStripMenuItem("Gateway: checking...");
            gatewayItem.Enabled = false;
            menu.Items.Add(gatewayItem);

            menu.Items.Add(new ToolStripSeparator());

            var infoItem = new ToolStripMenuItem("Show Nomsod MCP info...");
            infoItem.Click += delegate { ShowInfo(); };
            menu.Items.Add(infoItem);

            var revealKeysItem = new ToolStripMenuItem("Setup info & keys (Protected)...");
            revealKeysItem.Click += delegate { ShowProtectedSetupInfo(); };
            menu.Items.Add(revealKeysItem);

            var enrollMenu = new ToolStripMenuItem("Add new computer");
            var enrollWindows = new ToolStripMenuItem("Copy Windows install command");
            enrollWindows.Click += delegate { CopyEnrollmentCommand("windows"); };
            enrollMenu.DropDownItems.Add(enrollWindows);
            var enrollMac = new ToolStripMenuItem("Copy macOS install command");
            enrollMac.Click += delegate { CopyEnrollmentCommand("macos"); };
            enrollMenu.DropDownItems.Add(enrollMac);
            menu.Items.Add(enrollMenu);

            var copyUrlItem = new ToolStripMenuItem("Copy MCP URL");
            copyUrlItem.Click += delegate {
                Clipboard.SetText(GetPublicMcpUrl());
                tray.ShowBalloonTip(1500, "Nomsod MCP", "MCP URL copied.", ToolTipIcon.Info);
            };
            menu.Items.Add(copyUrlItem);

            var healthItem = new ToolStripMenuItem("Open MCP health");
            healthItem.Click += delegate {
                try { Process.Start(new ProcessStartInfo(GetPublicBaseUrl() + "/health") { UseShellExecute = true }); } catch { }
            };
            menu.Items.Add(healthItem);

            menu.Items.Add(new ToolStripSeparator());

            agentRestartItem = new ToolStripMenuItem("Restart Agent");
            agentRestartItem.Click += delegate { RestartTask("NomsodMCP-Agent", "Agent"); };
            menu.Items.Add(agentRestartItem);

            supervisorRestartItem = new ToolStripMenuItem("Restart Supervisor");
            supervisorRestartItem.Click += delegate { RestartTask("NomsodMCP-Supervisor", "Supervisor"); };
            menu.Items.Add(supervisorRestartItem);

            var restartAll = new ToolStripMenuItem("Restart Nomsod MCP");
            restartAll.Click += delegate {
                bool didAnything = false;
                if (TaskExists("NomsodMCP-Supervisor")) {
                    RestartTask("NomsodMCP-Supervisor", "Supervisor", false);
                    didAnything = true;
                }
                if (TaskExists("NomsodMCP-Agent")) {
                    RestartTask("NomsodMCP-Agent", "Agent", false);
                    didAnything = true;
                }
                tray.ShowBalloonTip(2000, "Nomsod MCP", didAnything ? "Restart requested." : "No Nomsod tasks are installed.", ToolTipIcon.Info);
            };
            menu.Items.Add(restartAll);

            menu.Items.Add(new ToolStripSeparator());

            var openLogs = new ToolStripMenuItem("Open logs folder");
            openLogs.Click += delegate {
                string p = Path.Combine(root, "data", "logs");
                Directory.CreateDirectory(p);
                try { Process.Start(new ProcessStartInfo("explorer.exe", "\"" + p + "\"") { UseShellExecute = true }); } catch { }
            };
            menu.Items.Add(openLogs);

            var quit = new ToolStripMenuItem("Quit Control");
            quit.Click += delegate { ExitControl(); };
            menu.Items.Add(quit);

            tray.ContextMenuStrip = menu;
            tray.DoubleClick += delegate { ShowInfo(); };

            timer = new Timer();
            timer.Interval = 5000;
            timer.Tick += delegate { RefreshStatus(); };
            timer.Start();

            RefreshStatus();
        }

        private void RefreshStatus()
        {
            try
            {
                env = ReadEnv(Path.Combine(root, ".env"));
                int agentPort = ParseInt(GetEnv("NOMSOD_AGENT_GUARDIAN_HEALTH_PORT", "3232"), 3232);
                string agentJson = HttpGet("http://127.0.0.1:" + agentPort + "/health", 1500);
                bool guardianOk = agentJson != null && agentJson.Contains("\"ok\":true");
                bool gatewayConnected = guardianOk && agentJson.Contains("\"gatewayConnected\":true");

                string identityPath = GetIdentityPath();
                string identityJson = File.Exists(identityPath) ? SafeReadAllText(identityPath) : "";
                string displayName = JsonString(identityJson, "displayName");
                string deviceId = JsonString(identityJson, "deviceId");
                if (String.IsNullOrWhiteSpace(displayName)) displayName = Environment.MachineName;
                if (String.IsNullOrWhiteSpace(deviceId)) deviceId = "(not paired)";

                statusItem.Text = gatewayConnected ? "Status: Online" : guardianOk ? "Status: Agent running / Gateway offline" : "Status: Offline";
                deviceItem.Text = "Device: " + displayName + "  [" + ShortId(deviceId) + "]";
                gatewayItem.Text = "Gateway: " + GetEnv("NOMSOD_GATEWAY_WS", "(not configured)");

                tray.Icon = appIcon;
                tray.Text = gatewayConnected ? "Nomsod MCP - Online" : "Nomsod MCP - Offline";

                agentRestartItem.Enabled = TaskExists("NomsodMCP-Agent");
                supervisorRestartItem.Enabled = TaskExists("NomsodMCP-Supervisor");
            }
            catch
            {
                statusItem.Text = "Status: Error";
                tray.Icon = appIcon;
            }
        }

        private void ShowInfo()
        {
            RefreshStatus();
            string identityPath = GetIdentityPath();
            string identityJson = File.Exists(identityPath) ? SafeReadAllText(identityPath) : "";
            string msg =
                "Nomsod MCP v" + GetVersion() + "\r\n\r\n" +
                "Computer: " + Environment.MachineName + "\r\n" +
                "Device name: " + ValueOr(JsonString(identityJson, "displayName"), "(not paired)") + "\r\n" +
                "Device ID: " + ValueOr(JsonString(identityJson, "deviceId"), "(not paired)") + "\r\n" +
                "Platform: Windows\r\n" +
                "Gateway: " + GetEnv("NOMSOD_GATEWAY_WS", "(not configured)") + "\r\n" +
                "MCP: " + GetPublicMcpUrl() + "\r\n" +
                "Project: " + root;
            MessageBox.Show(msg, "Nomsod MCP", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        private void ShowProtectedSetupInfo()
        {
            if (!VerifyOrSetPin()) return;
            ShowSetupInfoForm();
        }

        private static string Sha256(string value)
        {
            using (var sha = SHA256.Create())
            {
                byte[] bytes = sha.ComputeHash(Encoding.UTF8.GetBytes(value ?? ""));
                var sb = new StringBuilder();
                foreach (byte b in bytes) sb.Append(b.ToString("x2"));
                return sb.ToString();
            }
        }

        private bool VerifyOrSetPin()
        {
            string pinPath = Path.Combine(root, "data", "control.pin");
            bool hasPin = File.Exists(pinPath) && !String.IsNullOrWhiteSpace(SafeReadAllText(pinPath));

            using (var form = new Form())
            {
                form.Text = hasPin ? "Security PIN Required" : "Set Security PIN";
                form.FormBorderStyle = FormBorderStyle.FixedDialog;
                form.MaximizeBox = false;
                form.MinimizeBox = false;
                form.StartPosition = FormStartPosition.CenterScreen;
                form.ClientSize = new Size(360, 160);
                form.Icon = appIcon;
                form.Font = new Font("Segoe UI", 9.5f);

                var lbl = new Label() {
                    Left = 20, Top = 16, Width = 320, Height = 42,
                    Text = hasPin
                        ? "Enter your security PIN/password to view connection setup values and sensitive keys:"
                        : "Create a security PIN/password to protect your connection setup values and keys:"
                };
                form.Controls.Add(lbl);

                var txt = new TextBox() {
                    Left = 20, Top = 64, Width = 320,
                    UseSystemPasswordChar = true
                };
                form.Controls.Add(txt);

                var btnOk = new Button() {
                    Text = hasPin ? "Unlock" : "Save PIN",
                    Left = 160, Top = 108, Width = 85, Height = 30,
                    DialogResult = DialogResult.OK
                };
                var btnCancel = new Button() {
                    Text = "Cancel",
                    Left = 255, Top = 108, Width = 85, Height = 30,
                    DialogResult = DialogResult.Cancel
                };
                form.Controls.Add(btnOk);
                form.Controls.Add(btnCancel);
                form.AcceptButton = btnOk;
                form.CancelButton = btnCancel;

                if (form.ShowDialog() != DialogResult.OK) return false;

                string entered = txt.Text.Trim();
                if (String.IsNullOrEmpty(entered))
                {
                    MessageBox.Show("PIN/password cannot be empty.", "Nomsod MCP", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return false;
                }

                string enteredHash = Sha256(entered);
                if (hasPin)
                {
                    string storedHash = SafeReadAllText(pinPath).Trim();
                    if (String.Equals(enteredHash, storedHash, StringComparison.OrdinalIgnoreCase))
                    {
                        return true;
                    }
                    MessageBox.Show("Incorrect security PIN/password.", "Nomsod MCP", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return false;
                }
                else
                {
                    try
                    {
                        Directory.CreateDirectory(Path.GetDirectoryName(pinPath));
                        File.WriteAllText(pinPath, enteredHash + Environment.NewLine, Encoding.UTF8);
                        MessageBox.Show("Security PIN saved successfully.", "Nomsod MCP", MessageBoxButtons.OK, MessageBoxIcon.Information);
                        return true;
                    }
                    catch (Exception ex)
                    {
                        MessageBox.Show("Could not save PIN: " + ex.Message, "Nomsod MCP", MessageBoxButtons.OK, MessageBoxIcon.Error);
                        return false;
                    }
                }
            }
        }

        private void ResetPin()
        {
            string pinPath = Path.Combine(root, "data", "control.pin");
            if (File.Exists(pinPath))
            {
                if (!VerifyOrSetPin()) return;
                try { File.Delete(pinPath); } catch { }
            }
            VerifyOrSetPin();
        }

        private string GetGeminiClientSecret()
        {
            string envSecret = GetEnv("NOMSOD_GEMINI_CLIENT_SECRET", "");
            if (!String.IsNullOrWhiteSpace(envSecret)) return envSecret;

            string secretFile = Path.Combine(root, "data", "gemini-client.secret");
            string fileSecret = SafeReadAllText(secretFile).Trim();
            if (!String.IsNullOrWhiteSpace(fileSecret)) return fileSecret;

            return "(not generated yet)";
        }

        private string GetGeminiClientId()
        {
            return GetEnv("NOMSOD_GEMINI_CLIENT_ID", "gemini-enterprise");
        }

        private string GetOwnerKey()
        {
            string owner = GetEnv("NOMSOD_OWNER_KEY", "");
            if (!String.IsNullOrWhiteSpace(owner)) return owner;
            return GetEnv("NOMSOD_PAIRING_TOKEN", "(not stored on this computer)");
        }

        private void ShowSetupInfoForm()
        {
            env = ReadEnv(Path.Combine(root, ".env"));
            string identityPath = GetIdentityPath();
            string identityJson = File.Exists(identityPath) ? SafeReadAllText(identityPath) : "";

            string mcpUrl = GetPublicMcpUrl();
            string authUrl = GetPublicBaseUrl() + "/oauth/authorize";
            string tokenUrl = GetPublicBaseUrl() + "/oauth/token";
            string clientId = GetGeminiClientId();
            string clientSecret = GetGeminiClientSecret();
            string scope = "mcp";
            string ownerKey = GetOwnerKey();
            string pairingToken = GetEnv("NOMSOD_PAIRING_TOKEN", "(not stored on this computer)");
            string deviceId = ValueOr(JsonString(identityJson, "deviceId"), "(not paired)");

            using (var form = new Form())
            {
                form.Text = "Nomsod MCP - Setup Information & Keys";
                form.FormBorderStyle = FormBorderStyle.FixedDialog;
                form.MaximizeBox = false;
                form.MinimizeBox = false;
                form.StartPosition = FormStartPosition.CenterScreen;
                form.ClientSize = new Size(650, 520);
                form.Icon = appIcon;
                form.Font = new Font("Segoe UI", 9.0f);

                int y = 12;

                // Group 1: Gemini Enterprise Setup
                var grpGemini = new GroupBox() {
                    Text = " Gemini Enterprise MCP Configuration ",
                    Left = 16, Top = y, Width = 618, Height = 230,
                    Font = new Font("Segoe UI", 9.0f, FontStyle.Bold)
                };
                form.Controls.Add(grpGemini);

                int gy = 24;
                AddSetupField(grpGemini, "URL ของเซิร์ฟเวอร์:", mcpUrl, ref gy);
                AddSetupField(grpGemini, "URL การให้สิทธิ์:", authUrl, ref gy);
                AddSetupField(grpGemini, "URL โทเค็น:", tokenUrl, ref gy);
                AddSetupField(grpGemini, "รหัสไคลเอนต์:", clientId, ref gy);
                AddSetupField(grpGemini, "รหัสลับไคลเอนต์:", clientSecret, ref gy);
                AddSetupField(grpGemini, "ขอบเขต:", scope, ref gy);

                y += 240;

                // Group 2: Master Credentials
                var grpMaster = new GroupBox() {
                    Text = " Master Security Credentials ",
                    Left = 16, Top = y, Width = 618, Height = 160,
                    Font = new Font("Segoe UI", 9.0f, FontStyle.Bold)
                };
                form.Controls.Add(grpMaster);

                int my = 24;
                AddSetupField(grpMaster, "Owner Key:", ownerKey, ref my);
                AddSetupField(grpMaster, "Pairing Token:", pairingToken, ref my);
                AddSetupField(grpMaster, "Device ID:", deviceId, ref my);
                AddSetupField(grpMaster, "Gateway WS:", GetEnv("NOMSOD_GATEWAY_WS", "wss://mcp.nomsod.net/agent"), ref my);

                y += 175;

                // Buttons
                var btnCopyGemini = new Button() {
                    Text = "Copy Gemini Config",
                    Left = 16, Top = y, Width = 150, Height = 34,
                    Font = new Font("Segoe UI", 9.0f)
                };
                btnCopyGemini.Click += delegate {
                    string geminiAll =
                        "URL ของเซิร์ฟเวอร์: " + mcpUrl + "\r\n" +
                        "URL การให้สิทธิ์: " + authUrl + "\r\n" +
                        "URL โทเค็น: " + tokenUrl + "\r\n" +
                        "รหัสไคลเอนต์: " + clientId + "\r\n" +
                        "รหัสลับไคลเอนต์: " + clientSecret + "\r\n" +
                        "ขอบเขต: " + scope + "\r\n" +
                        "Owner key: " + ownerKey;
                    Clipboard.SetText(geminiAll);
                    btnCopyGemini.Text = "Copied!";
                    var t = new Timer() { Interval = 1500 };
                    t.Tick += delegate { btnCopyGemini.Text = "Copy Gemini Config"; t.Stop(); t.Dispose(); };
                    t.Start();
                };
                form.Controls.Add(btnCopyGemini);

                var btnCopyAll = new Button() {
                    Text = "Copy Everything",
                    Left = 174, Top = y, Width = 130, Height = 34,
                    Font = new Font("Segoe UI", 9.0f)
                };
                btnCopyAll.Click += delegate {
                    string all =
                        "=== Gemini Enterprise Setup ===\r\n" +
                        "MCP URL: " + mcpUrl + "\r\n" +
                        "Auth URL: " + authUrl + "\r\n" +
                        "Token URL: " + tokenUrl + "\r\n" +
                        "Client ID: " + clientId + "\r\n" +
                        "Client Secret: " + clientSecret + "\r\n" +
                        "Scope: " + scope + "\r\n\r\n" +
                        "=== Master Credentials ===\r\n" +
                        "Owner Key: " + ownerKey + "\r\n" +
                        "Pairing Token: " + pairingToken + "\r\n" +
                        "Device ID: " + deviceId;
                    Clipboard.SetText(all);
                    btnCopyAll.Text = "Copied!";
                    var t = new Timer() { Interval = 1500 };
                    t.Tick += delegate { btnCopyAll.Text = "Copy Everything"; t.Stop(); t.Dispose(); };
                    t.Start();
                };
                form.Controls.Add(btnCopyAll);

                var btnResetPin = new Button() {
                    Text = "Change PIN...",
                    Left = 312, Top = y, Width = 110, Height = 34,
                    Font = new Font("Segoe UI", 9.0f)
                };
                btnResetPin.Click += delegate {
                    ResetPin();
                };
                form.Controls.Add(btnResetPin);

                var btnClose = new Button() {
                    Text = "Close",
                    Left = 544, Top = y, Width = 90, Height = 34,
                    DialogResult = DialogResult.OK,
                    Font = new Font("Segoe UI", 9.0f)
                };
                form.Controls.Add(btnClose);
                form.CancelButton = btnClose;

                form.ShowDialog();
            }
        }

        private static void AddSetupField(GroupBox parent, string label, string value, ref int y)
        {
            var lbl = new Label() {
                Text = label,
                Left = 16, Top = y + 2, Width = 160, Height = 20,
                Font = new Font("Segoe UI", 8.5f, FontStyle.Regular)
            };
            parent.Controls.Add(lbl);

            var txt = new TextBox() {
                Text = value,
                Left = 180, Top = y, Width = 360, Height = 22,
                ReadOnly = true,
                BackColor = Color.White,
                Font = new Font("Consolas", 8.5f)
            };
            parent.Controls.Add(txt);

            var btn = new Button() {
                Text = "Copy",
                Left = 546, Top = y - 1, Width = 56, Height = 24,
                Font = new Font("Segoe UI", 8.0f)
            };
            btn.Click += delegate {
                Clipboard.SetText(value ?? "");
                btn.Text = "Copied";
                var t = new Timer() { Interval = 1200 };
                t.Tick += delegate { btn.Text = "Copy"; t.Stop(); t.Dispose(); };
                t.Start();
            };
            parent.Controls.Add(btn);

            y += 28;
        }

        private string GetVersion()
        {
            try
            {
                string file = Path.Combine(root, "VERSION");
                if (File.Exists(file))
                {
                    string value = File.ReadAllText(file, Encoding.UTF8).Trim();
                    if (!String.IsNullOrWhiteSpace(value)) return value;
                }
            }
            catch { }
            return "0.0.0";
        }

        private string GetIdentityPath()
        {
            string configured = GetEnv("NOMSOD_IDENTITY_PATH", "");
            if (!String.IsNullOrWhiteSpace(configured)) return Environment.ExpandEnvironmentVariables(configured);
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".nomsod-mcp", "device.json");
        }

        private string GetPublicBaseUrl()
        {
            string value = GetEnv("NOMSOD_PUBLIC_BASE_URL", "");
            if (!String.IsNullOrWhiteSpace(value)) return value.TrimEnd('/');
            string ws = GetEnv("NOMSOD_GATEWAY_WS", "wss://mcp.nomsod.net/agent");
            if (ws.StartsWith("wss://", StringComparison.OrdinalIgnoreCase))
                return "https://" + ws.Substring(6).Split('/')[0];
            if (ws.StartsWith("ws://", StringComparison.OrdinalIgnoreCase))
                return "http://" + ws.Substring(5).Split('/')[0];
            return "https://mcp.nomsod.net";
        }

        private string GetPublicMcpUrl() { return GetPublicBaseUrl() + "/mcp"; }

        private void CopyEnrollmentCommand(string platform)
        {
            try
            {
                env = ReadEnv(Path.Combine(root, ".env"));
                int controlPort = ParseInt(GetEnv("NOMSOD_CONTROL_PORT", "34102"), 34102);
                string controlKeyPath = Path.Combine(root, "data", "control.key");
                string controlKey = SafeReadAllText(controlKeyPath).Trim();

                if (String.IsNullOrWhiteSpace(controlKey))
                    throw new InvalidOperationException("Local control key is not available. Restart Supervisor once and try again.");

                string body = "{\"platform\":\"" + platform + "\",\"ttlSeconds\":600}";
                string json = HttpPostJson(
                    "http://127.0.0.1:" + controlPort + "/enrollment/invite",
                    body,
                    controlKey,
                    4000
                );

                string property = platform == "macos" ? "macosCommand" : "windowsCommand";
                string command = JsonString(json, property);
                if (String.IsNullOrWhiteSpace(command))
                    throw new InvalidOperationException("Supervisor did not return an enrollment command.");

                Clipboard.SetText(command);
                tray.ShowBalloonTip(
                    2500,
                    "Nomsod MCP",
                    (platform == "macos" ? "macOS" : "Windows") +
                    " enrollment command copied. It expires in 10 minutes.",
                    ToolTipIcon.Info
                );
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "Could not create enrollment command.\r\n\r\n" + ex.Message,
                    "Nomsod MCP",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
            }
        }

        private void ExportRecoveryKit()
        {
            try
            {
                var warning = MessageBox.Show(
                    "The recovery kit contains the credentials needed to restore your Nomsod cluster even if every Nomsod computer is wiped.\r\n\r\nAnyone who obtains this file can restore the cluster. Save it only to protected external storage.\r\n\r\nCreate the recovery kit now?",
                    "Nomsod MCP - Sensitive Recovery Kit",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Warning
                );
                if (warning != DialogResult.Yes) return;

                using (var dialog = new SaveFileDialog())
                {
                    dialog.Title = "Save Nomsod MCP Recovery Kit";
                    dialog.Filter = "ZIP archive (*.zip)|*.zip";
                    dialog.FileName = "Nomsod-Recovery-Kit-SENSITIVE.zip";
                    dialog.OverwritePrompt = true;

                    if (dialog.ShowDialog() != DialogResult.OK) return;

                    string script = Path.Combine(root, "scripts", "recovery", "export.ps1");
                    if (!File.Exists(script))
                        throw new FileNotFoundException("Recovery exporter is not installed.", script);

                    string args =
                        "-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File " +
                        QuoteArg(script) +
                        " -Root " + QuoteArg(root) +
                        " -Destination " + QuoteArg(dialog.FileName) +
                        " -Force";

                    int code = RunHidden("powershell.exe", args, 120000);
                    if (code != 0)
                        throw new InvalidOperationException("Recovery exporter failed with exit code " + code + ".");

                    MessageBox.Show(
                        "Recovery kit created.\r\n\r\nStore this ZIP outside Nomsod computers. It is a sensitive credential backup and is the file used to restore the same cluster when no old machine is available.",
                        "Nomsod MCP",
                        MessageBoxButtons.OK,
                        MessageBoxIcon.Information
                    );
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "Could not export recovery kit.\r\n\r\n" + ex.Message,
                    "Nomsod MCP",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error
                );
            }
        }

        private static string QuoteArg(string value)
        {
            return "\"" + (value ?? "").Replace("\"", "\\\"") + "\"";
        }

        private string GetEnv(string key, string fallback)
        {
            string v;
            return env.TryGetValue(key, out v) && !String.IsNullOrWhiteSpace(v) ? v : fallback;
        }

        private static Dictionary<string, string> ReadEnv(string path)
        {
            var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (!File.Exists(path)) return result;
            foreach (string raw in File.ReadAllLines(path, Encoding.UTF8))
            {
                string line = raw.Trim();
                if (line.Length == 0 || line.StartsWith("#")) continue;
                int i = line.IndexOf('=');
                if (i <= 0) continue;
                string key = line.Substring(0, i).Trim();
                string val = line.Substring(i + 1).Trim();
                if (val.Length >= 2 && ((val[0] == '"' && val[val.Length - 1] == '"') || (val[0] == '\'' && val[val.Length - 1] == '\'')))
                    val = val.Substring(1, val.Length - 2);
                result[key] = val;
            }
            return result;
        }

        private static string HttpGet(string url, int timeoutMs)
        {
            try
            {
                var req = (HttpWebRequest)WebRequest.Create(url);
                req.Method = "GET";
                req.Timeout = timeoutMs;
                req.ReadWriteTimeout = timeoutMs;
                using (var res = (HttpWebResponse)req.GetResponse())
                using (var sr = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                    return sr.ReadToEnd();
            }
            catch { return null; }
        }

        private static string HttpPostJson(string url, string body, string controlKey, int timeoutMs)
        {
            var req = (HttpWebRequest)WebRequest.Create(url);
            req.Method = "POST";
            req.ContentType = "application/json";
            req.Timeout = timeoutMs;
            req.ReadWriteTimeout = timeoutMs;
            req.Headers["X-Nomsod-Control-Key"] = controlKey;

            byte[] bytes = Encoding.UTF8.GetBytes(body);
            req.ContentLength = bytes.Length;
            using (var stream = req.GetRequestStream())
                stream.Write(bytes, 0, bytes.Length);

            using (var res = (HttpWebResponse)req.GetResponse())
            using (var sr = new StreamReader(res.GetResponseStream(), Encoding.UTF8))
                return sr.ReadToEnd();
        }

        private static string JsonString(string json, string key)
        {
            if (String.IsNullOrWhiteSpace(json)) return "";
            var m = Regex.Match(json, "\"" + Regex.Escape(key) + "\"\\s*:\\s*\"(?<v>(?:\\\\.|[^\"\\\\])*)\"");
            if (!m.Success) return "";
            return Regex.Unescape(m.Groups["v"].Value);
        }

        private static int ParseInt(string value, int fallback)
        {
            int v;
            return Int32.TryParse(value, out v) ? v : fallback;
        }

        private static string ShortId(string value)
        {
            if (String.IsNullOrWhiteSpace(value) || value.StartsWith("(")) return value;
            return value.Length <= 12 ? value : value.Substring(0, 12) + "...";
        }

        private static string ValueOr(string value, string fallback)
        {
            return String.IsNullOrWhiteSpace(value) ? fallback : value;
        }

        private static string SafeReadAllText(string path)
        {
            try { return File.ReadAllText(path, Encoding.UTF8); } catch { return ""; }
        }

        private static bool TaskExists(string name)
        {
            try
            {
                using (var p = Process.Start(new ProcessStartInfo("schtasks.exe", "/Query /TN \"" + name + "\"") {
                    UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true
                }))
                {
                    p.WaitForExit(3000);
                    return p.ExitCode == 0;
                }
            }
            catch { return false; }
        }

        private void RestartTask(string taskName, string label, bool balloon = true)
        {
            try
            {
                RunHidden("schtasks.exe", "/End /TN \"" + taskName + "\"", 5000);
                System.Threading.Thread.Sleep(400);
                int code = RunHidden("schtasks.exe", "/Run /TN \"" + taskName + "\"", 5000);
                if (balloon)
                    tray.ShowBalloonTip(1800, "Nomsod MCP", code == 0 ? label + " restart requested." : label + " restart failed.", code == 0 ? ToolTipIcon.Info : ToolTipIcon.Error);
            }
            catch
            {
                if (balloon) tray.ShowBalloonTip(1800, "Nomsod MCP", label + " restart failed.", ToolTipIcon.Error);
            }
        }

        private static int RunHidden(string file, string args, int timeout)
        {
            using (var p = Process.Start(new ProcessStartInfo(file, args) {
                UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden
            }))
            {
                if (!p.WaitForExit(timeout)) return -1;
                return p.ExitCode;
            }
        }

        private void ExitControl()
        {
            timer.Stop();
            tray.Visible = false;
            tray.Dispose();
            ExitThread();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                if (timer != null) timer.Dispose();
                if (tray != null) tray.Dispose();
                if (appIcon != null) appIcon.Dispose();
            }
            base.Dispose(disposing);
        }
    }

    internal static class Program
    {
        [STAThread]
        private static void Main(string[] args)
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            string root = args != null && args.Length > 0
                ? args[0]
                : AppDomain.CurrentDomain.BaseDirectory.TrimEnd(Path.DirectorySeparatorChar);

            bool created;
            using (var mutex = new System.Threading.Mutex(true, "Local\\NomsodMcpControl", out created))
            {
                if (!created) return;
                Application.Run(new NomsodApplicationContext(root));
            }
        }
    }
}
