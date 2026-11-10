// tawny-control.exe: persistent Windows helper for voice-driven computer control.
//
// It does what Node cannot: read the UI Automation tree of a window, move the
// real mouse with an animation, click, type, press keys, scroll, switch
// windows, list drives and take screenshots. It is started once and answers
// one request per line on stdin.
//
//   request : <id> TAB <command> TAB <key>=<percent-encoded value> ...
//   response: {"id":<id>,"ok":true,...}  or  {"id":<id>,"ok":false,"error":"<code>","message":"..."}
//
// Safety lives on the Node side (verb allow-list, confirmation, shell and
// elevated-window checks). This program only reports facts and performs the
// primitive it was asked for. There is no command here that runs a program.
// It exits when stdin closes, so it can never outlive Tawny.
//
// Language level: C# 5 (the compiler that ships with .NET Framework 4).

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;
using System.Windows.Forms;

namespace Tawny
{
    internal class HelperException : Exception
    {
        public readonly string Code;
        public HelperException(string code, string message) : base(message)
        {
            Code = code;
        }
    }

    internal static class Native
    {
        public const uint INPUT_MOUSE = 0;
        public const uint INPUT_KEYBOARD = 1;
        public const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
        public const uint MOUSEEVENTF_LEFTUP = 0x0004;
        public const uint MOUSEEVENTF_RIGHTDOWN = 0x0008;
        public const uint MOUSEEVENTF_RIGHTUP = 0x0010;
        public const uint MOUSEEVENTF_WHEEL = 0x0800;
        public const uint KEYEVENTF_EXTENDEDKEY = 0x0001;
        public const uint KEYEVENTF_KEYUP = 0x0002;
        public const uint KEYEVENTF_UNICODE = 0x0004;
        public const int SW_MINIMIZE = 6;
        public const int SW_MAXIMIZE = 3;
        public const int SW_RESTORE = 9;
        public const uint WM_CLOSE = 0x0010;
        public const int GWL_EXSTYLE = -20;
        public const long WS_EX_TOOLWINDOW = 0x00000080L;
        public const uint GW_OWNER = 4;
        public const int DWMWA_CLOAKED = 14;
        public const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
        public const uint TOKEN_QUERY = 0x0008;
        public const int TokenElevation = 20;

        [StructLayout(LayoutKind.Sequential)]
        public struct POINT
        {
            public int X;
            public int Y;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct MOUSEINPUT
        {
            public int dx;
            public int dy;
            public uint mouseData;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct KEYBDINPUT
        {
            public ushort wVk;
            public ushort wScan;
            public uint dwFlags;
            public uint time;
            public IntPtr dwExtraInfo;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct HARDWAREINPUT
        {
            public uint uMsg;
            public ushort wParamL;
            public ushort wParamH;
        }

        [StructLayout(LayoutKind.Explicit)]
        public struct InputUnion
        {
            [FieldOffset(0)]
            public MOUSEINPUT mi;
            [FieldOffset(0)]
            public KEYBDINPUT ki;
            [FieldOffset(0)]
            public HARDWAREINPUT hi;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct INPUT
        {
            public uint type;
            public InputUnion u;
        }

        public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
        [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
        [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
        [DllImport("user32.dll")] public static extern bool GetCursorPos(ref POINT point);
        [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint count, INPUT[] inputs, int size);
        [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
        [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
        [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc proc, IntPtr lParam);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
        [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
        [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, ref uint processId);
        [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, ref RECT rect);
        [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr hWnd, int index);
        [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string className, string windowName);
        [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
        [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
        [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
        [DllImport("user32.dll")] public static extern short VkKeyScan(char ch);
        [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint mapType);
        [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
        [DllImport("kernel32.dll")] public static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
        [DllImport("kernel32.dll")] public static extern bool CloseHandle(IntPtr handle);
        [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] public static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint size);
        [DllImport("advapi32.dll", SetLastError = true)] public static extern bool OpenProcessToken(IntPtr process, uint access, ref IntPtr token);
        [DllImport("advapi32.dll", SetLastError = true)] public static extern bool GetTokenInformation(IntPtr token, int infoClass, ref uint info, uint length, ref uint returned);
        [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attribute, ref int value, int size);
        [DllImport("winmm.dll")] public static extern uint timeBeginPeriod(uint period);
    }

    internal static class Json
    {
        public static string Str(string value)
        {
            if (value == null) value = "";
            StringBuilder sb = new StringBuilder(value.Length + 2);
            sb.Append('"');
            foreach (char c in value)
            {
                if (c == '"') sb.Append("\\\"");
                else if (c == '\\') sb.Append("\\\\");
                else if (c < 32 || c > 126) sb.Append("\\u").Append(((int)c).ToString("x4"));
                else sb.Append(c);
            }
            sb.Append('"');
            return sb.ToString();
        }

        public static string Bool(bool value)
        {
            return value ? "true" : "false";
        }
    }

    internal static class Program
    {
        private static readonly List<AutomationElement> Elements = new List<AutomationElement>();

        // ---------------------------------------------------------------- main loop

        private static int Main(string[] args)
        {
            bool aware = false;
            try
            {
                aware = SetPerMonitorDpi();
            }
            catch (Exception)
            {
            }
            if (!aware)
            {
                try
                {
                    Native.SetProcessDPIAware();
                }
                catch (Exception)
                {
                }
            }
            try
            {
                Native.timeBeginPeriod(1);
            }
            catch (Exception)
            {
            }

            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                line = line.Trim();
                if (line.Length == 0) continue;
                if (line == "exit") break;
                Console.Out.WriteLine(Handle(line));
                Console.Out.Flush();
            }
            return 0;
        }

        private static bool SetPerMonitorDpi()
        {
            // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 is -4 on Windows 10 1703 and later.
            return Native.SetProcessDpiAwarenessContext(new IntPtr(-4));
        }

        private static string Handle(string line)
        {
            string[] parts = line.Split('\t');
            long id;
            if (parts.Length < 2 || !long.TryParse(parts[0], NumberStyles.Integer, CultureInfo.InvariantCulture, out id))
            {
                return "{\"id\":0,\"ok\":false,\"error\":\"bad_request\",\"message\":\"Malformed request.\"}";
            }
            string command = parts[1];
            Dictionary<string, string> arguments = new Dictionary<string, string>();
            for (int i = 2; i < parts.Length; i++)
            {
                int eq = parts[i].IndexOf('=');
                if (eq <= 0) continue;
                arguments[parts[i].Substring(0, eq)] = Uri.UnescapeDataString(parts[i].Substring(eq + 1));
            }
            string idText = id.ToString(CultureInfo.InvariantCulture);
            try
            {
                string extra = Dispatch(command, arguments);
                return "{\"id\":" + idText + ",\"ok\":true" + extra + "}";
            }
            catch (HelperException ex)
            {
                return "{\"id\":" + idText + ",\"ok\":false,\"error\":" + Json.Str(ex.Code) + ",\"message\":" + Json.Str(ex.Message) + "}";
            }
            catch (ElementNotAvailableException)
            {
                return "{\"id\":" + idText + ",\"ok\":false,\"error\":\"no_element\",\"message\":\"That item is no longer on screen.\"}";
            }
            catch (Exception ex)
            {
                return "{\"id\":" + idText + ",\"ok\":false,\"error\":\"failed\",\"message\":" + Json.Str(ex.Message) + "}";
            }
        }

        private static string Dispatch(string command, Dictionary<string, string> a)
        {
            switch (command)
            {
                case "hello": return ",\"version\":1";
                case "foreground": return CmdForeground();
                case "windows": return CmdWindows();
                case "focus": return CmdFocus(ParseHwnd(Arg(a, "hwnd", "0")));
                case "window_state": return CmdWindowState(Arg(a, "state", ""), Arg(a, "hwnd", ""));
                case "drives": return CmdDrives();
                case "uia_snapshot": return CmdSnapshot(Arg(a, "hwnd", ""), Arg(a, "scope", "window"), ArgInt(a, "max", 600), ArgInt(a, "budget", 2500));
                case "uia_bounds": return CmdBounds(ArgInt(a, "id", -1));
                case "uia_scroll_into_view": return CmdScrollIntoView(ArgInt(a, "id", -1));
                case "uia_invoke": return CmdInvoke(ArgInt(a, "id", -1));
                case "cursor": return CmdCursor();
                case "move": return CmdMove(ArgInt(a, "x", 0), ArgInt(a, "y", 0), ArgInt(a, "ms", 0));
                case "click": return CmdClick(ArgInt(a, "x", 0), ArgInt(a, "y", 0), Arg(a, "button", "left"), ArgInt(a, "count", 1));
                case "type": return CmdType(Arg(a, "text", ""));
                case "key": return CmdKey(Arg(a, "combo", ""));
                case "scroll": return CmdScroll(ArgInt(a, "dy", 0));
                case "screenshot": return CmdScreenshot(ArgInt(a, "maxw", 1280), a);
                default: throw new HelperException("unknown_command", "Unknown command: " + command);
            }
        }

        private static string Arg(Dictionary<string, string> a, string key, string fallback)
        {
            string value;
            return a.TryGetValue(key, out value) ? value : fallback;
        }

        private static int ArgInt(Dictionary<string, string> a, string key, int fallback)
        {
            string value;
            int parsed;
            if (a.TryGetValue(key, out value) && int.TryParse(value, NumberStyles.Integer, CultureInfo.InvariantCulture, out parsed)) return parsed;
            return fallback;
        }

        private static IntPtr ParseHwnd(string text)
        {
            long value;
            if (!long.TryParse(text, NumberStyles.Integer, CultureInfo.InvariantCulture, out value)) return IntPtr.Zero;
            return new IntPtr(value);
        }

        private static string HwndText(IntPtr hwnd)
        {
            return hwnd.ToInt64().ToString(CultureInfo.InvariantCulture);
        }

        // ---------------------------------------------------------------- windows

        private static string TitleOf(IntPtr hwnd)
        {
            int length = Native.GetWindowTextLength(hwnd);
            if (length <= 0) return "";
            StringBuilder sb = new StringBuilder(length + 2);
            Native.GetWindowText(hwnd, sb, sb.Capacity);
            return sb.ToString();
        }

        private static uint PidOf(IntPtr hwnd)
        {
            uint pid = 0;
            Native.GetWindowThreadProcessId(hwnd, ref pid);
            return pid;
        }

        private static string ExeOf(uint pid)
        {
            IntPtr process = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (process == IntPtr.Zero) return "";
            try
            {
                StringBuilder sb = new StringBuilder(520);
                uint size = (uint)sb.Capacity;
                if (!Native.QueryFullProcessImageName(process, 0, sb, ref size)) return "";
                string path = sb.ToString();
                int slash = path.LastIndexOf('\\');
                return slash >= 0 ? path.Substring(slash + 1) : path;
            }
            finally
            {
                Native.CloseHandle(process);
            }
        }

        // A process whose token cannot be read is treated as elevated: the safe answer.
        private static bool IsElevated(uint pid)
        {
            IntPtr process = Native.OpenProcess(Native.PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
            if (process == IntPtr.Zero) return true;
            IntPtr token = IntPtr.Zero;
            try
            {
                if (!Native.OpenProcessToken(process, Native.TOKEN_QUERY, ref token)) return true;
                uint elevation = 0;
                uint returned = 0;
                if (!Native.GetTokenInformation(token, Native.TokenElevation, ref elevation, 4, ref returned)) return true;
                return elevation != 0;
            }
            finally
            {
                if (token != IntPtr.Zero) Native.CloseHandle(token);
                Native.CloseHandle(process);
            }
        }

        private static bool IsCloaked(IntPtr hwnd)
        {
            int cloaked = 0;
            try
            {
                if (Native.DwmGetWindowAttribute(hwnd, Native.DWMWA_CLOAKED, ref cloaked, 4) != 0) return false;
            }
            catch (Exception)
            {
                return false;
            }
            return cloaked != 0;
        }

        private static string RectFields(Native.RECT r)
        {
            return ",\"x\":" + r.Left + ",\"y\":" + r.Top + ",\"w\":" + (r.Right - r.Left) + ",\"h\":" + (r.Bottom - r.Top);
        }

        private static string CmdForeground()
        {
            IntPtr hwnd = Native.GetForegroundWindow();
            if (hwnd == IntPtr.Zero) throw new HelperException("no_window", "No window is in the foreground.");
            uint pid = PidOf(hwnd);
            Native.RECT rect = new Native.RECT();
            Native.GetWindowRect(hwnd, ref rect);
            return ",\"hwnd\":" + Json.Str(HwndText(hwnd)) + ",\"pid\":" + pid + ",\"title\":" + Json.Str(TitleOf(hwnd)) +
                ",\"exe\":" + Json.Str(ExeOf(pid)) + ",\"elevated\":" + Json.Bool(IsElevated(pid)) + RectFields(rect);
        }

        private static string CmdWindows()
        {
            List<string> items = new List<string>();
            Native.EnumWindowsProc callback = delegate(IntPtr hwnd, IntPtr lParam)
            {
                if (!Native.IsWindowVisible(hwnd)) return true;
                if (Native.GetWindow(hwnd, Native.GW_OWNER) != IntPtr.Zero) return true;
                long style = Native.GetWindowLongPtr(hwnd, Native.GWL_EXSTYLE).ToInt64();
                if ((style & Native.WS_EX_TOOLWINDOW) != 0) return true;
                string title = TitleOf(hwnd);
                if (title.Length == 0) return true;
                if (IsCloaked(hwnd)) return true;
                uint pid = PidOf(hwnd);
                items.Add("{\"hwnd\":" + Json.Str(HwndText(hwnd)) + ",\"pid\":" + pid + ",\"title\":" + Json.Str(title) + ",\"exe\":" + Json.Str(ExeOf(pid)) + "}");
                return true;
            };
            Native.EnumWindows(callback, IntPtr.Zero);
            GC.KeepAlive(callback);
            return ",\"windows\":[" + string.Join(",", items.ToArray()) + "]";
        }

        private static string CmdFocus(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero || !Native.IsWindow(hwnd)) throw new HelperException("no_window", "That window is gone.");
            if (Native.IsIconic(hwnd)) Native.ShowWindow(hwnd, Native.SW_RESTORE);
            IntPtr current = Native.GetForegroundWindow();
            uint currentThread = 0;
            uint unused = 0;
            if (current != IntPtr.Zero) currentThread = Native.GetWindowThreadProcessId(current, ref unused);
            uint thisThread = Native.GetCurrentThreadId();
            bool attached = false;
            try
            {
                if (currentThread != 0 && currentThread != thisThread) attached = Native.AttachThreadInput(thisThread, currentThread, true);
                // A tap on Alt lets this process take the foreground when Windows would otherwise only flash the taskbar button.
                Native.keybd_event(0x12, 0, 0, UIntPtr.Zero);
                Native.keybd_event(0x12, 0, Native.KEYEVENTF_KEYUP, UIntPtr.Zero);
                Native.SetForegroundWindow(hwnd);
            }
            finally
            {
                if (attached) Native.AttachThreadInput(thisThread, currentThread, false);
            }
            bool foreground = WaitForeground(hwnd, 12);
            if (!foreground)
            {
                // Windows' focus-stealing rules sometimes refuse SetForegroundWindow outright. Minimizing and
                // restoring the window is a user-visible activation the shell always honours.
                Native.ShowWindow(hwnd, Native.SW_MINIMIZE);
                Thread.Sleep(60);
                Native.ShowWindow(hwnd, Native.SW_RESTORE);
                Native.SetForegroundWindow(hwnd);
                foreground = WaitForeground(hwnd, 16);
            }
            return ",\"foreground\":" + Json.Bool(foreground);
        }

        private static bool WaitForeground(IntPtr hwnd, int attempts)
        {
            for (int i = 0; i < attempts; i++)
            {
                if (Native.GetForegroundWindow() == hwnd) return true;
                Thread.Sleep(25);
            }
            return false;
        }

        private static string CmdWindowState(string state, string hwndText)
        {
            IntPtr hwnd = hwndText.Length > 0 ? ParseHwnd(hwndText) : Native.GetForegroundWindow();
            if (hwnd == IntPtr.Zero || !Native.IsWindow(hwnd)) throw new HelperException("no_window", "There is no window to change.");
            if (state == "minimize") Native.ShowWindow(hwnd, Native.SW_MINIMIZE);
            else if (state == "maximize") Native.ShowWindow(hwnd, Native.SW_MAXIMIZE);
            else if (state == "restore") Native.ShowWindow(hwnd, Native.SW_RESTORE);
            else if (state == "close") Native.PostMessage(hwnd, Native.WM_CLOSE, IntPtr.Zero, IntPtr.Zero);
            else throw new HelperException("bad_request", "Unknown window operation.");
            return "";
        }

        private static string CmdDrives()
        {
            List<string> items = new List<string>();
            foreach (DriveInfo drive in DriveInfo.GetDrives())
            {
                string letter = drive.Name.Substring(0, 1).ToUpperInvariant();
                bool ready = false;
                string label = "";
                try
                {
                    ready = drive.IsReady;
                    if (ready) label = drive.VolumeLabel;
                }
                catch (Exception)
                {
                }
                items.Add("{\"name\":" + Json.Str(letter) + ",\"label\":" + Json.Str(label) + ",\"type\":" + Json.Str(drive.DriveType.ToString().ToLowerInvariant()) + ",\"ready\":" + Json.Bool(ready) + "}");
            }
            return ",\"drives\":[" + string.Join(",", items.ToArray()) + "]";
        }

        // ---------------------------------------------------------------- UI Automation

        private static string ControlTypeName(AutomationElement element)
        {
            string name = element.Cached.ControlType.ProgrammaticName;
            int dot = name.LastIndexOf('.');
            return dot >= 0 ? name.Substring(dot + 1) : name;
        }

        private static string PatternList(AutomationElement element)
        {
            List<string> names = new List<string>();
            if ((bool)element.GetCachedPropertyValue(AutomationElement.IsInvokePatternAvailableProperty)) names.Add("invoke");
            if ((bool)element.GetCachedPropertyValue(AutomationElement.IsSelectionItemPatternAvailableProperty)) names.Add("select");
            if ((bool)element.GetCachedPropertyValue(AutomationElement.IsTogglePatternAvailableProperty)) names.Add("toggle");
            if ((bool)element.GetCachedPropertyValue(AutomationElement.IsExpandCollapsePatternAvailableProperty)) names.Add("expand");
            return string.Join(",", names.ToArray());
        }

        private static string CmdSnapshot(string hwndText, string scope, int max, int budgetMs)
        {
            IntPtr hwnd;
            if (scope == "taskbar")
            {
                hwnd = Native.FindWindow("Shell_TrayWnd", null);
                if (hwnd == IntPtr.Zero) throw new HelperException("no_window", "The taskbar was not found.");
            }
            else
            {
                hwnd = hwndText.Length > 0 ? ParseHwnd(hwndText) : Native.GetForegroundWindow();
                if (hwnd == IntPtr.Zero || !Native.IsWindow(hwnd)) throw new HelperException("no_window", "There is no window to read.");
            }
            if (max < 1) max = 1;
            if (max > 2000) max = 2000;
            if (budgetMs < 200) budgetMs = 200;

            AutomationElementCollection found = null;
            Exception failure = null;
            Thread worker = new Thread(delegate()
            {
                try
                {
                    AutomationElement root = AutomationElement.FromHandle(hwnd);
                    CacheRequest request = new CacheRequest();
                    request.Add(AutomationElement.NameProperty);
                    request.Add(AutomationElement.ControlTypeProperty);
                    request.Add(AutomationElement.AutomationIdProperty);
                    request.Add(AutomationElement.BoundingRectangleProperty);
                    request.Add(AutomationElement.IsEnabledProperty);
                    request.Add(AutomationElement.IsOffscreenProperty);
                    request.Add(AutomationElement.IsInvokePatternAvailableProperty);
                    request.Add(AutomationElement.IsSelectionItemPatternAvailableProperty);
                    request.Add(AutomationElement.IsTogglePatternAvailableProperty);
                    request.Add(AutomationElement.IsExpandCollapsePatternAvailableProperty);
                    request.TreeScope = TreeScope.Element;
                    using (request.Activate())
                    {
                        found = root.FindAll(TreeScope.Descendants, Condition.TrueCondition);
                    }
                }
                catch (Exception ex)
                {
                    failure = ex;
                }
            });
            worker.IsBackground = true;
            worker.Start();
            if (!worker.Join(budgetMs))
            {
                throw new HelperException("uia_timeout", "That window took too long to read.");
            }
            if (failure != null) throw new HelperException("uia_failed", failure.Message);

            Elements.Clear();
            List<string> items = new List<string>();
            bool truncated = false;
            if (found != null)
            {
                foreach (AutomationElement element in found)
                {
                    string name;
                    string autoId;
                    System.Windows.Rect rect;
                    try
                    {
                        name = element.Cached.Name;
                        autoId = element.Cached.AutomationId;
                        rect = element.Cached.BoundingRectangle;
                    }
                    catch (Exception)
                    {
                        continue;
                    }
                    if ((name == null || name.Length == 0) && (autoId == null || autoId.Length == 0)) continue;
                    if (rect.IsEmpty || double.IsInfinity(rect.Width) || double.IsInfinity(rect.X) || rect.Width < 1 || rect.Height < 1) continue;
                    if (items.Count >= max)
                    {
                        truncated = true;
                        break;
                    }
                    int index = Elements.Count;
                    Elements.Add(element);
                    items.Add("{\"id\":" + index + ",\"name\":" + Json.Str(name) + ",\"type\":" + Json.Str(ControlTypeName(element)) +
                        ",\"autoId\":" + Json.Str(autoId) + ",\"x\":" + (int)Math.Round(rect.X) + ",\"y\":" + (int)Math.Round(rect.Y) +
                        ",\"w\":" + (int)Math.Round(rect.Width) + ",\"h\":" + (int)Math.Round(rect.Height) +
                        ",\"enabled\":" + Json.Bool(element.Cached.IsEnabled) + ",\"offscreen\":" + Json.Bool(element.Cached.IsOffscreen) +
                        ",\"patterns\":" + Json.Str(PatternList(element)) + "}");
                }
            }
            return ",\"hwnd\":" + Json.Str(HwndText(hwnd)) + ",\"truncated\":" + Json.Bool(truncated) + ",\"elements\":[" + string.Join(",", items.ToArray()) + "]";
        }

        private static AutomationElement ElementById(int id)
        {
            if (id < 0 || id >= Elements.Count) throw new HelperException("no_element", "That item is not in the last snapshot.");
            return Elements[id];
        }

        private static string CmdBounds(int id)
        {
            AutomationElement element = ElementById(id);
            System.Windows.Rect rect = element.Current.BoundingRectangle;
            if (rect.IsEmpty || double.IsInfinity(rect.Width)) throw new HelperException("no_element", "That item is no longer visible.");
            return ",\"x\":" + (int)Math.Round(rect.X) + ",\"y\":" + (int)Math.Round(rect.Y) + ",\"w\":" + (int)Math.Round(rect.Width) +
                ",\"h\":" + (int)Math.Round(rect.Height) + ",\"offscreen\":" + Json.Bool(element.Current.IsOffscreen);
        }

        private static string CmdScrollIntoView(int id)
        {
            AutomationElement element = ElementById(id);
            object pattern;
            if (element.TryGetCurrentPattern(ScrollItemPattern.Pattern, out pattern))
            {
                ((ScrollItemPattern)pattern).ScrollIntoView();
            }
            return "";
        }

        private static string CmdInvoke(int id)
        {
            AutomationElement element = ElementById(id);
            object pattern;
            if (element.TryGetCurrentPattern(InvokePattern.Pattern, out pattern))
            {
                ((InvokePattern)pattern).Invoke();
                return ",\"pattern\":\"invoke\"";
            }
            if (element.TryGetCurrentPattern(SelectionItemPattern.Pattern, out pattern))
            {
                ((SelectionItemPattern)pattern).Select();
                return ",\"pattern\":\"select\"";
            }
            if (element.TryGetCurrentPattern(ExpandCollapsePattern.Pattern, out pattern))
            {
                ((ExpandCollapsePattern)pattern).Expand();
                return ",\"pattern\":\"expand\"";
            }
            throw new HelperException("no_pattern", "That item cannot be activated directly.");
        }

        // ---------------------------------------------------------------- mouse

        private static string CmdCursor()
        {
            Native.POINT p = new Native.POINT();
            Native.GetCursorPos(ref p);
            return ",\"x\":" + p.X + ",\"y\":" + p.Y;
        }

        private static string CmdMove(int x, int y, int ms)
        {
            Native.POINT start = new Native.POINT();
            Native.GetCursorPos(ref start);
            if (ms <= 0 || (Math.Abs(start.X - x) < 3 && Math.Abs(start.Y - y) < 3))
            {
                Native.SetCursorPos(x, y);
                return ",\"x\":" + x + ",\"y\":" + y;
            }
            Stopwatch clock = Stopwatch.StartNew();
            int lastX = start.X;
            int lastY = start.Y;
            while (true)
            {
                Native.POINT now = new Native.POINT();
                Native.GetCursorPos(ref now);
                // If the person grabs the mouse mid-animation, stop at once and say so.
                if (Math.Abs(now.X - lastX) > 6 || Math.Abs(now.Y - lastY) > 6)
                {
                    throw new HelperException("user_moved", "The mouse was moved by the user.");
                }
                double t = clock.ElapsedMilliseconds / (double)ms;
                if (t >= 1.0) break;
                double eased = t * t * (3.0 - 2.0 * t);
                lastX = (int)Math.Round(start.X + (x - start.X) * eased);
                lastY = (int)Math.Round(start.Y + (y - start.Y) * eased);
                Native.SetCursorPos(lastX, lastY);
                Thread.Sleep(6);
            }
            Native.SetCursorPos(x, y);
            return ",\"x\":" + x + ",\"y\":" + y;
        }

        private static Native.INPUT MouseInput(uint flags, uint data)
        {
            Native.INPUT input = new Native.INPUT();
            input.type = Native.INPUT_MOUSE;
            input.u.mi.dwFlags = flags;
            input.u.mi.mouseData = data;
            return input;
        }

        private static void Send(List<Native.INPUT> inputs)
        {
            if (inputs.Count == 0) return;
            Native.INPUT[] array = inputs.ToArray();
            uint sent = Native.SendInput((uint)array.Length, array, Marshal.SizeOf(typeof(Native.INPUT)));
            if (sent != (uint)array.Length)
            {
                throw new HelperException("input_blocked", "Windows blocked the input. The target window may be running as administrator.");
            }
        }

        private static string CmdClick(int x, int y, string button, int count)
        {
            Native.POINT p = new Native.POINT();
            Native.GetCursorPos(ref p);
            if (Math.Abs(p.X - x) > 2 || Math.Abs(p.Y - y) > 2) Native.SetCursorPos(x, y);
            if (count < 1) count = 1;
            if (count > 3) count = 3;
            bool right = button == "right";
            uint down = right ? Native.MOUSEEVENTF_RIGHTDOWN : Native.MOUSEEVENTF_LEFTDOWN;
            uint up = right ? Native.MOUSEEVENTF_RIGHTUP : Native.MOUSEEVENTF_LEFTUP;
            for (int i = 0; i < count; i++)
            {
                List<Native.INPUT> pair = new List<Native.INPUT>();
                pair.Add(MouseInput(down, 0));
                pair.Add(MouseInput(up, 0));
                Send(pair);
                if (i < count - 1) Thread.Sleep(45);
            }
            return "";
        }

        private static string CmdScroll(int notches)
        {
            if (notches == 0) return "";
            if (notches > 40) notches = 40;
            if (notches < -40) notches = -40;
            int direction = notches > 0 ? 1 : -1;
            int amount = Math.Abs(notches);
            for (int i = 0; i < amount; i++)
            {
                List<Native.INPUT> one = new List<Native.INPUT>();
                uint data = unchecked((uint)(direction * 120));
                one.Add(MouseInput(Native.MOUSEEVENTF_WHEEL, data));
                Send(one);
                Thread.Sleep(12);
            }
            return "";
        }

        // ---------------------------------------------------------------- keyboard

        private static Native.INPUT KeyInput(ushort vk, ushort scan, uint flags)
        {
            Native.INPUT input = new Native.INPUT();
            input.type = Native.INPUT_KEYBOARD;
            input.u.ki.wVk = vk;
            input.u.ki.wScan = scan;
            input.u.ki.dwFlags = flags;
            return input;
        }

        private static string CmdType(string text)
        {
            if (text.Length > 2000) throw new HelperException("too_long", "That is too much text to type at once.");
            List<Native.INPUT> inputs = new List<Native.INPUT>();
            foreach (char c in text)
            {
                if (c == '\r') continue;
                if (c == '\n')
                {
                    inputs.Add(KeyInput(0x0D, 0, 0));
                    inputs.Add(KeyInput(0x0D, 0, Native.KEYEVENTF_KEYUP));
                }
                else if (c == '\t')
                {
                    inputs.Add(KeyInput(0x09, 0, 0));
                    inputs.Add(KeyInput(0x09, 0, Native.KEYEVENTF_KEYUP));
                }
                else
                {
                    inputs.Add(KeyInput(0, (ushort)c, Native.KEYEVENTF_UNICODE));
                    inputs.Add(KeyInput(0, (ushort)c, Native.KEYEVENTF_UNICODE | Native.KEYEVENTF_KEYUP));
                }
                if (inputs.Count >= 120)
                {
                    Send(inputs);
                    inputs.Clear();
                    Thread.Sleep(4);
                }
            }
            Send(inputs);
            return "";
        }

        private static bool NamedKey(string name, out ushort vk, ref bool extended)
        {
            extended = false;
            vk = 0;
            switch (name)
            {
                case "enter": case "return": vk = 0x0D; return true;
                case "esc": case "escape": vk = 0x1B; return true;
                case "tab": vk = 0x09; return true;
                case "space": vk = 0x20; return true;
                case "backspace": vk = 0x08; return true;
                case "delete": case "del": vk = 0x2E; extended = true; return true;
                case "insert": vk = 0x2D; extended = true; return true;
                case "home": vk = 0x24; extended = true; return true;
                case "end": vk = 0x23; extended = true; return true;
                case "pageup": case "pgup": vk = 0x21; extended = true; return true;
                case "pagedown": case "pgdn": vk = 0x22; extended = true; return true;
                case "up": vk = 0x26; extended = true; return true;
                case "down": vk = 0x28; extended = true; return true;
                case "left": vk = 0x25; extended = true; return true;
                case "right": vk = 0x27; extended = true; return true;
                case "minus": vk = 0xBD; return true;
                case "plus": case "equals": vk = 0xBB; return true;
                case "comma": vk = 0xBC; return true;
                case "period": vk = 0xBE; return true;
            }
            if (name.Length >= 2 && name[0] == 'f')
            {
                int number;
                if (int.TryParse(name.Substring(1), NumberStyles.Integer, CultureInfo.InvariantCulture, out number) && number >= 1 && number <= 24)
                {
                    vk = (ushort)(0x6F + number);
                    return true;
                }
            }
            if (name.Length == 1)
            {
                char c = name[0];
                if (c >= 'a' && c <= 'z')
                {
                    vk = (ushort)(c - 'a' + 0x41);
                    return true;
                }
                if (c >= '0' && c <= '9')
                {
                    vk = (ushort)c;
                    return true;
                }
                short scanned = Native.VkKeyScan(c);
                if (scanned != -1)
                {
                    vk = (ushort)(scanned & 0xFF);
                    return true;
                }
            }
            return false;
        }

        private static string CmdKey(string combo)
        {
            string[] tokens = combo.ToLowerInvariant().Split('+');
            List<ushort> modifiers = new List<ushort>();
            ushort key = 0;
            bool keyExtended = false;
            bool haveKey = false;
            foreach (string raw in tokens)
            {
                string token = raw.Trim();
                if (token.Length == 0) continue;
                if (token == "ctrl" || token == "control") modifiers.Add(0x11);
                else if (token == "shift") modifiers.Add(0x10);
                else if (token == "alt") modifiers.Add(0x12);
                else if (token == "win" || token == "windows" || token == "super") modifiers.Add(0x5B);
                else
                {
                    if (haveKey) throw new HelperException("bad_key", "Only one main key is allowed in a combination.");
                    if (!NamedKey(token, out key, ref keyExtended)) throw new HelperException("bad_key", "Unknown key: " + token);
                    haveKey = true;
                }
            }
            if (!haveKey && modifiers.Count == 0) throw new HelperException("bad_key", "No key was given.");
            List<Native.INPUT> inputs = new List<Native.INPUT>();
            foreach (ushort modifier in modifiers)
            {
                uint flags = modifier == 0x5B ? Native.KEYEVENTF_EXTENDEDKEY : 0;
                inputs.Add(KeyInput(modifier, (ushort)Native.MapVirtualKey(modifier, 0), flags));
            }
            if (haveKey)
            {
                uint flags = keyExtended ? Native.KEYEVENTF_EXTENDEDKEY : 0;
                ushort scan = (ushort)Native.MapVirtualKey(key, 0);
                inputs.Add(KeyInput(key, scan, flags));
                inputs.Add(KeyInput(key, scan, flags | Native.KEYEVENTF_KEYUP));
            }
            for (int i = modifiers.Count - 1; i >= 0; i--)
            {
                ushort modifier = modifiers[i];
                uint flags = Native.KEYEVENTF_KEYUP | (modifier == 0x5B ? Native.KEYEVENTF_EXTENDEDKEY : 0);
                inputs.Add(KeyInput(modifier, (ushort)Native.MapVirtualKey(modifier, 0), flags));
            }
            Send(inputs);
            return "";
        }

        // ---------------------------------------------------------------- screenshot

        private static string CmdScreenshot(int maxWidth, Dictionary<string, string> a)
        {
            Native.POINT cursor = new Native.POINT();
            Native.GetCursorPos(ref cursor);
            Screen screen = Screen.FromPoint(new System.Drawing.Point(cursor.X, cursor.Y));
            Rectangle bounds = screen.Bounds;
            Rectangle area = bounds;
            if (a.ContainsKey("w") && a.ContainsKey("h"))
            {
                Rectangle requested = new Rectangle(ArgInt(a, "x", bounds.X), ArgInt(a, "y", bounds.Y), ArgInt(a, "w", bounds.Width), ArgInt(a, "h", bounds.Height));
                area = Rectangle.Intersect(requested, bounds);
                if (area.Width < 8 || area.Height < 8) throw new HelperException("bad_region", "That region is not on the screen.");
            }
            if (maxWidth < 64) maxWidth = 64;
            if (maxWidth > 2560) maxWidth = 2560;
            int outW = area.Width;
            int outH = area.Height;
            if (outW > maxWidth)
            {
                outH = (int)Math.Round(area.Height * (maxWidth / (double)area.Width));
                outW = maxWidth;
            }
            string base64;
            using (Bitmap full = new Bitmap(area.Width, area.Height, PixelFormat.Format24bppRgb))
            {
                using (Graphics g = Graphics.FromImage(full))
                {
                    g.CopyFromScreen(area.X, area.Y, 0, 0, area.Size, CopyPixelOperation.SourceCopy);
                }
                using (Bitmap scaled = new Bitmap(outW, outH, PixelFormat.Format24bppRgb))
                {
                    using (Graphics g = Graphics.FromImage(scaled))
                    {
                        g.InterpolationMode = System.Drawing.Drawing2D.InterpolationMode.HighQualityBicubic;
                        g.DrawImage(full, 0, 0, outW, outH);
                    }
                    ImageCodecInfo codec = null;
                    foreach (ImageCodecInfo candidate in ImageCodecInfo.GetImageEncoders())
                    {
                        if (candidate.MimeType == "image/jpeg") codec = candidate;
                    }
                    using (MemoryStream stream = new MemoryStream())
                    {
                        EncoderParameters parameters = new EncoderParameters(1);
                        parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 72L);
                        scaled.Save(stream, codec, parameters);
                        base64 = Convert.ToBase64String(stream.ToArray());
                    }
                }
            }
            return ",\"w\":" + outW + ",\"h\":" + outH + ",\"screen\":{\"x\":" + bounds.X + ",\"y\":" + bounds.Y + ",\"w\":" + bounds.Width + ",\"h\":" + bounds.Height + "},\"jpeg\":" + Json.Str(base64);
        }
    }
}
