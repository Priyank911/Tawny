using System;
using System.Runtime.InteropServices;
using System.Threading;

class KeyWatcher {
    [DllImport("user32.dll")]
    public static extern short GetAsyncKeyState(int vKey);

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

    static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
    const uint SWP_NOSIZE = 0x0001;
    const uint SWP_NOMOVE = 0x0002;
    const uint SWP_NOACTIVATE = 0x0010;
    const uint SWP_SHOWWINDOW = 0x0040;

    static void Main(string[] args) {
        Console.OutputEncoding = System.Text.Encoding.UTF8;
        string line;
        while ((line = Console.ReadLine()) != null) {
            line = line.Trim();
            if (line == "watch") {
                // Settle delay after initial hotkey trigger
                Thread.Sleep(80);

                // Sample keys over ~500ms to determine if the user is holding down (push-to-talk)
                // or just tapped the shortcut to speak hands-free.
                bool isHold = true;
                for (int i = 0; i < 25; i++) {
                    short sp = GetAsyncKeyState(0x20);   // VK_SPACE
                    short ctrl = GetAsyncKeyState(0x11); // VK_CONTROL
                    short alt = GetAsyncKeyState(0x12);  // VK_MENU

                    bool spDown = (sp & 0x8000) != 0;
                    bool ctrlDown = (ctrl & 0x8000) != 0;
                    bool altDown = (alt & 0x8000) != 0;

                    bool keysHeld = spDown || (ctrlDown && altDown);
                    if (!keysHeld) {
                        // User released keys within 500ms: this was a tap, NOT a push-to-talk hold!
                        // In tap mode, stay listening hands-free. Do not send release.
                        isHold = false;
                        break;
                    }
                    Thread.Sleep(20);
                }

                if (isHold) {
                    // Push-to-talk: User is holding the keys down while speaking.
                    // Wait until they actually release the keys.
                    int releaseCount = 0;
                    while (true) {
                        short sp = GetAsyncKeyState(0x20);
                        short ctrl = GetAsyncKeyState(0x11);
                        short alt = GetAsyncKeyState(0x12);

                        bool spDown = (sp & 0x8000) != 0;
                        bool ctrlDown = (ctrl & 0x8000) != 0;
                        bool altDown = (alt & 0x8000) != 0;

                        bool keysHeld = spDown || (ctrlDown && altDown);

                        if (!keysHeld) {
                            releaseCount++;
                            // Debounce: require 4 consecutive samples (~80ms) of release
                            if (releaseCount >= 4) {
                                Console.WriteLine("released");
                                break;
                            }
                        } else {
                            releaseCount = 0;
                        }
                        Thread.Sleep(20);
                    }
                } else {
                    // Tap mode: user tapped to start recording.
                    // Keep listening hands-free. The user will press shortcut again or click to stop.
                }
            } else if (line.StartsWith("topmost ")) {
                string hwndStr = line.Substring(8).Trim();
                long hwndVal;
                if (long.TryParse(hwndStr, out hwndVal)) {
                    IntPtr hwnd = new IntPtr(hwndVal);
                    SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_SHOWWINDOW);
                    Console.WriteLine("topmost_ok");
                }
            } else if (line == "exit") {
                break;
            }
        }
    }
}
