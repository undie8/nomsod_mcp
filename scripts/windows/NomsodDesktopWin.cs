using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Text;

public class Program {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr OpenWindowStation(string lpszWinSta, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetProcessWindowStation(IntPtr hWinSta);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr OpenDesktop(string lpszDesktop, uint dwFlags, bool fInherit, uint dwDesiredAccess);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool SetThreadDesktop(IntPtr hDesktop);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumWindowsProc lpfn, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool SetCursorPos(int X, int Y);

    [DllImport("user32.dll")]
    public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, int dwExtraInfo);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool BringWindowToTop(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("kernel32.dll")]
    public static extern uint GetCurrentThreadId();

    [DllImport("user32.dll")]
    public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X; public int Y; }

    [DllImport("user32.dll")]
    public static extern bool GetCursorPos(out POINT lpPoint);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [StructLayout(LayoutKind.Sequential)]
    public struct INPUT {
        public uint type;
        public MOUSEKEYBDHARDWAREINPUT mi;
    }

    [StructLayout(LayoutKind.Explicit)]
    public struct MOUSEKEYBDHARDWAREINPUT {
        [FieldOffset(0)] public KEYBDINPUT ki;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct KEYBDINPUT {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    public const uint INPUT_KEYBOARD = 1;
    public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
    public const uint KEYEVENTF_KEYUP = 0x0002;
    public const uint KEYEVENTF_UNICODE = 0x0004;

    public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    public const uint MOUSEEVENTF_LEFTUP = 0x0004;
    public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
    public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
    public const uint MOUSEEVENTF_MIDDLEDOWN = 0x0020;
    public const uint MOUSEEVENTF_MIDDLEUP = 0x0040;

    public const int SW_RESTORE = 9;
    public const uint GW_OWNER = 4;

    public static IntPtr ActiveDesktop = IntPtr.Zero;

    public static void AttachToUserDesktop() {
        try {
            IntPtr hWinsta = OpenWindowStation("winsta0", false, 0x10000000);
            if (hWinsta != IntPtr.Zero) SetProcessWindowStation(hWinsta);
            IntPtr hDesk = OpenDesktop("Default", 0, false, 0x10000000);
            if (hDesk != IntPtr.Zero) {
                SetThreadDesktop(hDesk);
                ActiveDesktop = hDesk;
            }
        } catch {}
    }

    public static string EscapeJson(string s) {
        if (s == null) return "";
        return s.Replace("\\", "\\\\")
                .Replace("\"", "\\\"")
                .Replace("\r", "\\r")
                .Replace("\n", "\\n")
                .Replace("\t", "\\t");
    }

    public static void SendUnicodeText(string text) {
        if (string.IsNullOrEmpty(text)) return;
        INPUT[] inputs = new INPUT[text.Length * 2];
        int idx = 0;
        foreach (char c in text) {
            inputs[idx].type = INPUT_KEYBOARD;
            inputs[idx].mi.ki.wVk = 0;
            inputs[idx].mi.ki.wScan = (ushort)c;
            inputs[idx].mi.ki.dwFlags = KEYEVENTF_UNICODE;
            idx++;

            inputs[idx].type = INPUT_KEYBOARD;
            inputs[idx].mi.ki.wVk = 0;
            inputs[idx].mi.ki.wScan = (ushort)c;
            inputs[idx].mi.ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
            idx++;
        }
        SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static ushort ResolveVk(string key) {
        switch (key.ToLowerInvariant()) {
            case "enter": case "return": return 0x0D;
            case "tab": return 0x09;
            case "escape": case "esc": return 0x1B;
            case "backspace": return 0x08;
            case "delete": case "del": return 0x2E;
            case "space": return 0x20;
            case "left": return 0x25;
            case "up": return 0x26;
            case "right": return 0x27;
            case "down": return 0x28;
            case "pageup": return 0x21;
            case "pagedown": return 0x22;
            case "home": return 0x24;
            case "end": return 0x23;
            case "f1": return 0x70;
            case "f2": return 0x71;
            case "f3": return 0x72;
            case "f4": return 0x73;
            case "f5": return 0x74;
            case "f6": return 0x75;
            case "f7": return 0x76;
            case "f8": return 0x77;
            case "f9": return 0x78;
            case "f10": return 0x79;
            case "f11": return 0x7A;
            case "f12": return 0x7B;
            default:
                if (key.Length == 1) {
                    char c = char.ToUpperInvariant(key[0]);
                    if (c >= 'A' && c <= 'Z') return (ushort)c;
                    if (c >= '0' && c <= '9') return (ushort)c;
                }
                return 0;
        }
    }

    public static ushort ResolveMod(string mod) {
        switch (mod.ToLowerInvariant()) {
            case "ctrl": case "control": return 0x11;
            case "alt": case "menu": return 0x12;
            case "shift": return 0x10;
            case "cmd": case "meta": case "win": return 0x5B;
            default: return 0;
        }
    }

    public static void SendKey(string key, string[] modifiers) {
        ushort vk = ResolveVk(key);
        if (vk == 0 && key.Length > 0) {
            SendUnicodeText(key);
            return;
        }

        List<ushort> mods = new List<ushort>();
        if (modifiers != null) {
            foreach (var m in modifiers) {
                ushort modVk = ResolveMod(m);
                if (modVk != 0) mods.Add(modVk);
            }
        }

        int count = mods.Count * 2 + 2;
        INPUT[] inputs = new INPUT[count];
        int idx = 0;

        foreach (var m in mods) {
            inputs[idx].type = INPUT_KEYBOARD;
            inputs[idx].mi.ki.wVk = m;
            inputs[idx].mi.ki.dwFlags = 0;
            idx++;
        }

        inputs[idx].type = INPUT_KEYBOARD;
        inputs[idx].mi.ki.wVk = vk;
        inputs[idx].mi.ki.dwFlags = 0;
        idx++;

        inputs[idx].type = INPUT_KEYBOARD;
        inputs[idx].mi.ki.wVk = vk;
        inputs[idx].mi.ki.dwFlags = KEYEVENTF_KEYUP;
        idx++;

        for (int i = mods.Count - 1; i >= 0; i--) {
            inputs[idx].type = INPUT_KEYBOARD;
            inputs[idx].mi.ki.wVk = mods[i];
            inputs[idx].mi.ki.dwFlags = KEYEVENTF_KEYUP;
            idx++;
        }

        SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT)));
    }

    public static void FocusWindow(IntPtr hWnd) {
        if (IsIconic(hWnd)) {
            ShowWindow(hWnd, SW_RESTORE);
        }
        IntPtr fgWnd = GetForegroundWindow();
        uint fgProcId;
        uint fgThread = GetWindowThreadProcessId(fgWnd, out fgProcId);
        uint curThread = GetCurrentThreadId();
        if (fgThread != 0 && fgThread != curThread) {
            AttachThreadInput(curThread, fgThread, true);
            SetForegroundWindow(hWnd);
            BringWindowToTop(hWnd);
            AttachThreadInput(curThread, fgThread, false);
        } else {
            SetForegroundWindow(hWnd);
            BringWindowToTop(hWnd);
        }
    }

    public static int Main(string[] args) {
        Console.OutputEncoding = Encoding.UTF8;
        AttachToUserDesktop();

        if (args.Length == 0) {
            Console.WriteLine("{\"ok\":false,\"error\":\"no command specified\"}");
            return 1;
        }

        string cmd = args[0].ToLowerInvariant();

        try {
            if (cmd == "pos") {
                POINT pt;
                GetCursorPos(out pt);
                Console.WriteLine(string.Format("{{\"ok\":true,\"x\":{0},\"y\":{1}}}", pt.X, pt.Y));
                return 0;
            }

            if (cmd == "move") {
                if (args.Length < 3) {
                    Console.WriteLine("{\"ok\":false,\"error\":\"usage: move <x> <y>\"}");
                    return 1;
                }
                int x = int.Parse(args[1]);
                int y = int.Parse(args[2]);
                SetCursorPos(x, y);
                Console.WriteLine(string.Format("{{\"ok\":true,\"x\":{0},\"y\":{1}}}", x, y));
                return 0;
            }

            if (cmd == "click") {
                POINT pt;
                GetCursorPos(out pt);
                int x = pt.X;
                int y = pt.Y;
                string button = "left";
                bool isDouble = false;

                if (args.Length >= 3 && int.TryParse(args[1], out x) && int.TryParse(args[2], out y)) {
                    SetCursorPos(x, y);
                    if (args.Length >= 4) button = args[3].ToLowerInvariant();
                    if (args.Length >= 5) bool.TryParse(args[4], out isDouble);
                } else if (args.Length >= 2) {
                    button = args[1].ToLowerInvariant();
                    if (args.Length >= 3) bool.TryParse(args[2], out isDouble);
                }

                uint down = MOUSEEVENTF_LEFTDOWN;
                uint up = MOUSEEVENTF_LEFTUP;
                if (button == "right") { down = MOUSEEVENTF_RIGHTDOWN; up = MOUSEEVENTF_RIGHTUP; }
                else if (button == "middle") { down = MOUSEEVENTF_MIDDLEDOWN; up = MOUSEEVENTF_MIDDLEUP; }

                mouse_event(down, 0, 0, 0, 0);
                mouse_event(up, 0, 0, 0, 0);

                if (isDouble) {
                    System.Threading.Thread.Sleep(50);
                    mouse_event(down, 0, 0, 0, 0);
                    mouse_event(up, 0, 0, 0, 0);
                }

                Console.WriteLine(string.Format("{{\"ok\":true,\"x\":{0},\"y\":{1},\"button\":\"{2}\",\"double\":{3}}}",
                    x, y, button, isDouble ? "true" : "false"));
                return 0;
            }

            if (cmd == "type") {
                if (args.Length < 2) {
                    Console.WriteLine("{\"ok\":false,\"error\":\"usage: type <text>\"}");
                    return 1;
                }
                string text = args[1];
                SendUnicodeText(text);
                Console.WriteLine(string.Format("{{\"ok\":true,\"text\":\"{0}\",\"length\":{1}}}", EscapeJson(text), text.Length));
                return 0;
            }

            if (cmd == "key") {
                if (args.Length < 2) {
                    Console.WriteLine("{\"ok\":false,\"error\":\"usage: key <key> [modifiers]\"}");
                    return 1;
                }
                string key = args[1];
                string[] mods = args.Length >= 3 && !string.IsNullOrEmpty(args[2])
                    ? args[2].Split(new char[] { ',', '+', ' ' }, StringSplitOptions.RemoveEmptyEntries)
                    : new string[0];
                SendKey(key, mods);
                Console.WriteLine(string.Format("{{\"ok\":true,\"key\":\"{0}\"}}", EscapeJson(key)));
                return 0;
            }

            if (cmd == "windows") {
                string filter = args.Length >= 2 ? args[1].ToLowerInvariant() : "";
                List<string> jsonItems = new List<string>();

                EnumDesktopWindows(ActiveDesktop, (hWnd, lParam) => {
                    if (!IsWindowVisible(hWnd)) return true;

                    StringBuilder sb = new StringBuilder(512);
                    int len = GetWindowText(hWnd, sb, 512);
                    if (len == 0) return true;
                    string title = sb.ToString().Trim();
                    if (string.IsNullOrEmpty(title)) return true;
                    if (title == "Default IME" || title == "MSCTFIME UI" || title == "CiceroUIWndFrame") return true;

                    RECT rect;
                    GetWindowRect(hWnd, out rect);
                    int width = rect.Right - rect.Left;
                    int height = rect.Bottom - rect.Top;
                    if (width <= 10 || height <= 10) return true;

                    IntPtr owner = GetWindow(hWnd, GW_OWNER);
                    if (owner != IntPtr.Zero) return true;

                    uint pid;
                    GetWindowThreadProcessId(hWnd, out pid);
                    string processName = "";
                    try {
                        var p = Process.GetProcessById((int)pid);
                        processName = p.ProcessName;
                    } catch {}

                    if (!string.IsNullOrEmpty(filter)) {
                        if (!title.ToLowerInvariant().Contains(filter) && !processName.ToLowerInvariant().Contains(filter)) {
                            return true;
                        }
                    }

                    string item = string.Format(
                        "{{\"id\":{0},\"title\":\"{1}\",\"processName\":\"{2}\",\"pid\":{3},\"bounds\":{{\"x\":{4},\"y\":{5},\"width\":{6},\"height\":{7}}}}}",
                        hWnd.ToInt64(),
                        EscapeJson(title),
                        EscapeJson(processName),
                        pid,
                        rect.Left,
                        rect.Top,
                        width,
                        height
                    );
                    jsonItems.Add(item);
                    return true;
                }, IntPtr.Zero);

                Console.WriteLine("{\"ok\":true,\"windows\":[" + string.Join(",", jsonItems.ToArray()) + "]}");
                return 0;
            }

            if (cmd == "focus") {
                long targetId = 0;
                string targetTitle = "";
                string targetProc = "";

                if (args.Length >= 2) {
                    if (!long.TryParse(args[1], out targetId)) {
                        targetTitle = args[1].ToLowerInvariant();
                    }
                }
                if (args.Length >= 3) {
                    targetProc = args[2].ToLowerInvariant();
                }

                IntPtr foundHwnd = IntPtr.Zero;
                string foundTitle = "";
                string foundProc = "";

                EnumDesktopWindows(ActiveDesktop, (hWnd, lParam) => {
                    if (!IsWindowVisible(hWnd)) return true;

                    StringBuilder sb = new StringBuilder(512);
                    int len = GetWindowText(hWnd, sb, 512);
                    if (len == 0) return true;
                    string title = sb.ToString().Trim();
                    if (string.IsNullOrEmpty(title)) return true;
                    if (title == "Default IME" || title == "MSCTFIME UI" || title == "CiceroUIWndFrame") return true;

                    uint pid;
                    GetWindowThreadProcessId(hWnd, out pid);
                    string processName = "";
                    try {
                        var p = Process.GetProcessById((int)pid);
                        processName = p.ProcessName;
                    } catch {}

                    if (targetId != 0 && hWnd.ToInt64() == targetId) {
                        foundHwnd = hWnd;
                        foundTitle = title;
                        foundProc = processName;
                        return false;
                    }

                    if (!string.IsNullOrEmpty(targetTitle) && title.ToLowerInvariant().Contains(targetTitle)) {
                        foundHwnd = hWnd;
                        foundTitle = title;
                        foundProc = processName;
                        return false;
                    }

                    if (!string.IsNullOrEmpty(targetProc) && processName.ToLowerInvariant().Contains(targetProc)) {
                        foundHwnd = hWnd;
                        foundTitle = title;
                        foundProc = processName;
                        return false;
                    }

                    return true;
                }, IntPtr.Zero);

                if (foundHwnd != IntPtr.Zero) {
                    FocusWindow(foundHwnd);
                    Console.WriteLine(string.Format(
                        "{{\"ok\":true,\"focused\":true,\"window\":{{\"id\":{0},\"title\":\"{1}\",\"processName\":\"{2}\"}}}}",
                        foundHwnd.ToInt64(),
                        EscapeJson(foundTitle),
                        EscapeJson(foundProc)
                    ));
                    return 0;
                }

                Console.WriteLine("{\"ok\":false,\"focused\":false,\"error\":\"window not found\"}");
                return 0;
            }

            Console.WriteLine(string.Format("{{\"ok\":false,\"error\":\"unknown command: {0}\"}}", cmd));
            return 1;
        } catch (Exception ex) {
            Console.WriteLine(string.Format("{{\"ok\":false,\"error\":\"{0}\"}}", EscapeJson(ex.Message)));
            return 1;
        }
    }
}
