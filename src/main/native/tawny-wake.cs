// tawny-wake.exe: local wake-phrase listener for Windows.
//
// Runs the built-in Windows speech recognizer (System.Speech, offline) in
// dictation mode and prints what it hears as one JSON object per line:
//   {"t":"ready","culture":"en-IN"}
//   {"t":"hyp","text":"hey tony"}      partial guess while the person is talking
//   {"t":"final","text":"hey tawny open downloads"}
//   {"t":"error","code":"no_recognizer|no_audio_device|start_failed","message":"..."}
// The Node side decides what counts as the wake phrase and verifies it with
// a second, more accurate pass, so this program only reports text. Audio never
// leaves the machine from here. It exits when stdin closes or says "exit", so
// it can never outlive Tawny.
//
// Language level: C# 5 (the compiler that ships with .NET Framework 4).

using System;
using System.Globalization;
using System.Speech.Recognition;
using System.Text;
using System.Threading;

namespace Tawny
{
    internal static class WakeProgram
    {
        private static readonly object OutputLock = new object();
        private static readonly ManualResetEvent Quit = new ManualResetEvent(false);
        private static string lastHypothesis = "";

        private static void Emit(string json)
        {
            lock (OutputLock)
            {
                Console.Out.WriteLine(json);
                Console.Out.Flush();
            }
        }

        private static string Escape(string value)
        {
            StringBuilder sb = new StringBuilder(value.Length + 8);
            foreach (char c in value)
            {
                if (c == '"') sb.Append("\\\"");
                else if (c == '\\') sb.Append("\\\\");
                else if (c < 32 || c > 126) sb.Append("\\u").Append(((int)c).ToString("x4"));
                else sb.Append(c);
            }
            return sb.ToString();
        }

        private static void EmitError(string code, string message)
        {
            Emit("{\"t\":\"error\",\"code\":\"" + code + "\",\"message\":\"" + Escape(message) + "\"}");
        }

        private static RecognizerInfo ChooseRecognizer()
        {
            RecognizerInfo best = null;
            int bestRank = int.MaxValue;
            foreach (RecognizerInfo info in SpeechRecognitionEngine.InstalledRecognizers())
            {
                string name = info.Culture.Name;
                int rank;
                if (name == "en-IN") rank = 0;
                else if (name == "en-US") rank = 1;
                else if (name == "en-GB") rank = 2;
                else if (info.Culture.TwoLetterISOLanguageName == "en") rank = 3;
                else continue;
                if (rank < bestRank)
                {
                    best = info;
                    bestRank = rank;
                }
            }
            return best;
        }

        private static void WatchStdin()
        {
            try
            {
                string line;
                while ((line = Console.In.ReadLine()) != null)
                {
                    if (line.Trim().ToLowerInvariant() == "exit") break;
                }
            }
            catch (Exception)
            {
            }
            Quit.Set();
        }

        private static int Main(string[] args)
        {
            RecognizerInfo info;
            try
            {
                info = ChooseRecognizer();
            }
            catch (Exception ex)
            {
                EmitError("no_recognizer", ex.Message);
                return 2;
            }
            if (info == null)
            {
                EmitError("no_recognizer", "No English speech recognizer is installed.");
                return 2;
            }

            SpeechRecognitionEngine engine = null;
            try
            {
                engine = new SpeechRecognitionEngine(info);
                engine.LoadGrammar(new DictationGrammar());
                engine.SpeechHypothesized += delegate(object sender, SpeechHypothesizedEventArgs e)
                {
                    string text = e.Result.Text;
                    if (string.IsNullOrEmpty(text) || text == lastHypothesis) return;
                    lastHypothesis = text;
                    Emit("{\"t\":\"hyp\",\"text\":\"" + Escape(text) + "\"}");
                };
                engine.SpeechRecognized += delegate(object sender, SpeechRecognizedEventArgs e)
                {
                    lastHypothesis = "";
                    string text = e.Result.Text;
                    if (string.IsNullOrEmpty(text)) return;
                    Emit("{\"t\":\"final\",\"text\":\"" + Escape(text) + "\"}");
                };
                engine.SpeechRecognitionRejected += delegate(object sender, SpeechRecognitionRejectedEventArgs e)
                {
                    lastHypothesis = "";
                };
                engine.RecognizeCompleted += delegate(object sender, RecognizeCompletedEventArgs e)
                {
                    if (e.Error != null)
                    {
                        EmitError("start_failed", e.Error.Message);
                        Quit.Set();
                    }
                };
            }
            catch (Exception ex)
            {
                EmitError("start_failed", ex.Message);
                return 3;
            }

            try
            {
                engine.SetInputToDefaultAudioDevice();
            }
            catch (Exception ex)
            {
                EmitError("no_audio_device", ex.Message);
                return 4;
            }

            Thread watcher = new Thread(WatchStdin);
            watcher.IsBackground = true;
            watcher.Start();

            try
            {
                engine.RecognizeAsync(RecognizeMode.Multiple);
            }
            catch (Exception ex)
            {
                EmitError("start_failed", ex.Message);
                return 3;
            }

            Emit("{\"t\":\"ready\",\"culture\":\"" + Escape(info.Culture.Name) + "\"}");
            Quit.WaitOne();
            try
            {
                engine.RecognizeAsyncCancel();
                engine.Dispose();
            }
            catch (Exception)
            {
            }
            return 0;
        }
    }
}
