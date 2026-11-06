// tawny-wake.exe: local wake-phrase listener for Windows.
//
// Runs the built-in Windows speech recognizer (System.Speech, offline) with a
// grammar for "hey|hi|okay Tawny [anything]" and "Tawny send it", and prints
// what it hears as one JSON object per line:
//   {"t":"ready","culture":"en-IN"}
//   {"t":"hyp","text":"hey Tawny","c":0.71}   partial guess while the person is talking
//   {"t":"final","text":"hey Tawny open downloads","c":0.83}
//   {"t":"error","code":"no_recognizer|no_audio_device|start_failed","message":"..."}
// Free dictation is loaded beside the wake grammar so ordinary speech has
// somewhere to go other than a forced "hey Tawny" match; its final results also
// tell Tawny when a sentence ended. Speech adaptation is switched off: Tawny
// listens all day, and letting that reshape the Windows speech profile made
// recognition of the wake phrase drift from one day to the next.
// Tuning flags: --wav file, --dictation-weight 0..1, --name-only 0|1.
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
        // Measured on 60 synthesized clips: dictation alongside the wake grammar gives the fewest false wakes,
        // and "Tawny" alone as a wake word tripled them. Both stay switchable for tuning runs.
        private const float DefaultDictationWeight = 1f;
        private const bool DefaultNameOnly = false;
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

        // "hey|hi|okay Tawny", optionally followed by the command in the same breath. With nameOnly,
        // "Tawny" on its own also starts a request ("Tawny, open D drive").
        private static Grammar BuildWakeGrammar(bool nameOnly)
        {
            Choices forms = new Choices();
            foreach (bool greeted in nameOnly ? new[] { true, false } : new[] { true })
            {
                GrammarBuilder phrase = greeted ? new GrammarBuilder(new Choices("hey", "hi", "okay")) : new GrammarBuilder();
                phrase.Append("Tawny");
                GrammarBuilder withCommand = greeted ? new GrammarBuilder(new Choices("hey", "hi", "okay")) : new GrammarBuilder();
                withCommand.Append("Tawny");
                withCommand.AppendDictation();
                forms.Add(new GrammarBuilder[] { withCommand, phrase });
            }
            Grammar grammar = new Grammar(new GrammarBuilder(forms));
            grammar.Name = "wake";
            grammar.Priority = 10;
            return grammar;
        }

        // "Tawny send it" (with or without the greeting, which the wake grammar already covers).
        private static Grammar BuildSendGrammar()
        {
            GrammarBuilder send = new GrammarBuilder("Tawny");
            send.Append(new Choices("send it", "send that", "send this", "send now"));
            Grammar grammar = new Grammar(send);
            grammar.Name = "send";
            return grammar;
        }

        private static string Confidence(float value)
        {
            return value.ToString("0.00", CultureInfo.InvariantCulture);
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
            // Test mode: "tawny-wake.exe --wav file.wav" recognizes a recording instead of the microphone.
            string wavPath = null;
            float dictationWeight = DefaultDictationWeight;
            bool nameOnly = DefaultNameOnly;
            for (int i = 0; i + 1 < args.Length; i += 2)
            {
                if (args[i] == "--wav") wavPath = args[i + 1];
                else if (args[i] == "--dictation-weight") dictationWeight = float.Parse(args[i + 1], CultureInfo.InvariantCulture);
                else if (args[i] == "--name-only") nameOnly = args[i + 1] == "1";
            }
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
                try
                {
                    engine.UpdateRecognizerSetting("AdaptationOn", 0);
                }
                catch (Exception)
                {
                    // Not every recognizer exposes the setting; recognition still works without it.
                }
                // Free dictation alone never hears "Tawny": it is not a dictionary word, so it comes
                // back as "a tiny" or "T tiny". A dedicated wake grammar makes the phrase something
                // the recognizer actively listens for. Dictation stays loaded for "send it" and for
                // everything that is not addressed to Tawny.
                engine.LoadGrammar(BuildWakeGrammar(nameOnly));
                engine.LoadGrammar(BuildSendGrammar());
                if (dictationWeight > 0)
                {
                    DictationGrammar dictation = new DictationGrammar();
                    dictation.Name = "dictation";
                    dictation.Weight = dictationWeight;
                    engine.LoadGrammar(dictation);
                }
                engine.SpeechHypothesized += delegate(object sender, SpeechHypothesizedEventArgs e)
                {
                    string text = e.Result.Text;
                    if (string.IsNullOrEmpty(text) || text == lastHypothesis) return;
                    lastHypothesis = text;
                    Emit("{\"t\":\"hyp\",\"text\":\"" + Escape(text) + "\",\"c\":" + Confidence(e.Result.Confidence) + "}");
                };
                engine.SpeechRecognized += delegate(object sender, SpeechRecognizedEventArgs e)
                {
                    lastHypothesis = "";
                    string text = e.Result.Text;
                    if (string.IsNullOrEmpty(text)) return;
                    Emit("{\"t\":\"final\",\"text\":\"" + Escape(text) + "\",\"c\":" + Confidence(e.Result.Confidence) + "}");
                };
                engine.SpeechRecognitionRejected += delegate(object sender, SpeechRecognitionRejectedEventArgs e)
                {
                    lastHypothesis = "";
                };
                engine.RecognizeCompleted += delegate(object sender, RecognizeCompletedEventArgs e)
                {
                    if (e.Error != null) EmitError("start_failed", e.Error.Message);
                    // Live input only completes on error; a test file completes when it ends.
                    if (e.Error != null || wavPath != null) Quit.Set();
                };
            }
            catch (Exception ex)
            {
                EmitError("start_failed", ex.Message);
                return 3;
            }

            try
            {
                if (wavPath != null) engine.SetInputToWaveFile(wavPath);
                else engine.SetInputToDefaultAudioDevice();
            }
            catch (Exception ex)
            {
                EmitError("no_audio_device", ex.Message);
                return 4;
            }

            if (wavPath == null)
            {
                Thread watcher = new Thread(WatchStdin);
                watcher.IsBackground = true;
                watcher.Start();
            }

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
