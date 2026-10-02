// A Windows `git.exe` shim for the control specs (B988). Compiled on demand by
// test/helpers/win-git-shim.ts with the .NET Framework C# compiler that ships with every Windows
// (no SDK needed), and put FIRST on PATH as `git.exe`.
//
// Why an exe: on POSIX the specs drop an extensionless `git` sh script first on PATH. Windows cannot
// run that as `git` (CreateProcess needs an image, and Node resolves `git` to `git.exe`), so on
// Windows the same shim jobs are done by this one binary, configured through the environment:
//
//   SHIM_LOG        append `<args joined by space>` per call              (the makeGitShim log)
//   SHIM_ARGV_LOG   append `["arg","arg"]` (one JSON array) per call      (the argv-shim log)
//   SHIM_RACE_DIR   on the first `push`, commit a rival ctl/state to that bare repo (a lost race)
//   SHIM_FAIL_ON    `push` etc.: a call whose args contain it prints SHIM_FAIL_MSG to stderr, exits 1;
//                   `*` fails EVERY call (a stub git that never reaches the real one)
//   SHIM_FAIL_MSG   the stderr line for SHIM_FAIL_ON
//   REAL_GIT        the real git executable every other call is forwarded to (stdio inherited)
//
// Written for the C# 5 compiler (no interpolation, no ?.). Nothing here touches the network.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Text;

static class GitShim
{
    // Quote one argument the way CommandLineToArgvW reads it back.
    static string Quote(string a)
    {
        if (a.Length > 0 && a.IndexOfAny(new char[] { ' ', '\t', '\n', '\v', '"' }) < 0) return a;
        StringBuilder sb = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char c in a)
        {
            if (c == '\\') { backslashes++; continue; }
            if (c == '"')
            {
                sb.Append('\\', backslashes * 2 + 1);
                sb.Append('"');
                backslashes = 0;
                continue;
            }
            sb.Append('\\', backslashes);
            backslashes = 0;
            sb.Append(c);
        }
        sb.Append('\\', backslashes * 2);
        sb.Append('"');
        return sb.ToString();
    }

    static string JoinQuoted(IList<string> args)
    {
        List<string> q = new List<string>();
        foreach (string a in args) q.Add(Quote(a));
        return string.Join(" ", q.ToArray());
    }

    static string Env(string name)
    {
        string v = Environment.GetEnvironmentVariable(name);
        return string.IsNullOrEmpty(v) ? null : v;
    }

    static void AppendLine(string path, string line)
    {
        File.AppendAllText(path, line + "\n", new UTF8Encoding(false));
    }

    // Run the real git quietly with an empty stdin; returns trimmed stdout.
    static string RealGitOut(string realGit, string args)
    {
        ProcessStartInfo psi = new ProcessStartInfo(realGit, args);
        psi.UseShellExecute = false;
        psi.RedirectStandardInput = true;
        psi.RedirectStandardOutput = true;
        psi.CreateNoWindow = true;
        using (Process p = Process.Start(psi))
        {
            p.StandardInput.Close();
            string o = p.StandardOutput.ReadToEnd();
            p.WaitForExit();
            return o.Trim();
        }
    }

    static int Main(string[] args)
    {
        string realGit = Env("REAL_GIT");
        string log = Env("SHIM_LOG");
        if (log != null) AppendLine(log, string.Join(" ", args));

        string argvLog = Env("SHIM_ARGV_LOG");
        if (argvLog != null)
        {
            StringBuilder sb = new StringBuilder("[");
            for (int i = 0; i < args.Length; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append('"').Append(args[i].Replace("\\", "\\\\").Replace("\"", "\\\"")).Append('"');
            }
            sb.Append(']');
            AppendLine(argvLog, sb.ToString());
        }

        string failOn = Env("SHIM_FAIL_ON");
        if (failOn != null)
        {
            bool hit = failOn == "*" || Array.IndexOf(args, failOn) >= 0;
            if (hit)
            {
                Console.Error.WriteLine(Env("SHIM_FAIL_MSG") ?? "fatal: shim refused");
                return 1;
            }
        }

        string raceDir = Env("SHIM_RACE_DIR");
        if (raceDir != null && realGit != null && Array.IndexOf(args, "push") >= 0 && !File.Exists(raceDir + ".raced"))
        {
            File.WriteAllText(raceDir + ".raced", "");
            string tree = RealGitOut(realGit, "-C " + Quote(raceDir) + " hash-object -t tree -w --stdin");
            string commit = RealGitOut(realGit, "-C " + Quote(raceDir) + " commit-tree -m race " + Quote(tree));
            RealGitOut(realGit, "-C " + Quote(raceDir) + " update-ref refs/heads/ctl/state " + Quote(commit));
        }

        if (realGit == null)
        {
            Console.Error.WriteLine("git shim: REAL_GIT is not set");
            return 127;
        }
        ProcessStartInfo run = new ProcessStartInfo(realGit, JoinQuoted(args));
        run.UseShellExecute = false; // stdin / stdout / stderr are inherited from the caller
        using (Process p = Process.Start(run))
        {
            p.WaitForExit();
            return p.ExitCode;
        }
    }
}
