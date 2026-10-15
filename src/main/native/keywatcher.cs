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
                // Wait 100ms for initial key combination to settle
                Thread.Sleep(100);

                // Sample the key states over the next 240ms to determine if the user is holding the shortcut
                int heldCount = 0;
                for (int i = 0; i < 15; i++) {
                    short sp = GetAsyncKeyState(0x20);   // VK_SPACE
                    short ctrl = GetAsyncKeyState(0x11); // VK_CONTROL
                    short alt = GetAsyncKeyState(0x12);  // VK_MENU

                    bool spDown = (sp & 0x8000) != 0;
                    bool ctrlDown = (ctrl & 0x8000) != 0;
                    bool altDown = (alt & 0x8000) != 0;

                    // If user is holding Space OR holding modifiers
                    if (spDown || (ctrlDown && altDown)) {
                        heldCount++;
                    }
                    Thread.Sleep(16);
                }

                // If user held keys during the sample window, they are holding to talk
                if (heldCount >= 6) {
                    // Loop continuously while the user speaks; release when they leave the keys
                    int releaseCount = 0;
                    while (true) {
                        short sp = GetAsyncKeyState(0x20);
                        short ctrl = GetAsyncKeyState(0x11);
                        short alt = GetAsyncKeyState(0x12);

                        bool spDown = (sp & 0x8000) != 0;
                        bool ctrlDown = (ctrl & 0x8000) != 0;
                        bool altDown = (alt & 0x8000) != 0;

                        // Key is released when Space is not pressed AND at least one modifier is released,
                        // or when all keys are released
                        bool isReleased = (!spDown && (!ctrlDown || !altDown));

                        if (isReleased) {
                            releaseCount++;
                            // Debounce: require 3 consecutive samples (~45ms) of released state
                            if (releaseCount >= 3) {
                                Console.WriteLine("released");
                                break;
                            }
                        } else {
                            releaseCount = 0;
                        }
                        Thread.Sleep(15);
                    }
                } else {
                    // Quick tap - user tapped to start recording; do not send release, let user speak freely
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
