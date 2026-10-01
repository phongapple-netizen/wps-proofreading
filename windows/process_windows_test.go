//go:build windows

package main

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func testBatch(t *testing.T, body string) opencodeCandidate {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "npm with spaces")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	filename := filepath.Join(dir, "opencode.cmd")
	if err := os.WriteFile(filename, []byte("@echo off\r\n"+body+"\r\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	return opencodeCandidate{path: filename, cmd: true}
}

func TestBatchVersionExecutesWithSpaceInPath(t *testing.T) {
	c := testBatch(t, "if \"%~1\"==\"--version\" echo 1.18.34")
	if got := (&openCodeManager{}).version(c); got != "1.18.34" {
		t.Fatalf("actual cmd version execution failed: %q", got)
	}
}

func TestBatchServeArgumentsSurviveHiddenLaunch(t *testing.T) {
	output := filepath.Join(t.TempDir(), "arguments.txt")
	c := testBatch(t, `>"%~1" echo %~2^|%~3^|%~4^|%~5^|%~6^|%~7^|%~8`)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	cmd, err := commandForContext(ctx, c, output, "serve", "--hostname", "127.0.0.1", "--port", "4096", "--cors", "http://127.0.0.1:3891")
	if err != nil {
		t.Fatal(err)
	}
	line := cmd.SysProcAttr.CmdLine
	if err := startHidden(cmd); err != nil {
		t.Fatal(err)
	}
	if cmd.SysProcAttr.CmdLine != line || line == "" {
		t.Fatal("hidden launch lost command line")
	}
	if err := cmd.Wait(); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.TrimSpace(string(data)); got != "serve|--hostname|127.0.0.1|--port|4096|--cors|http://127.0.0.1:3891" {
		t.Fatalf("arguments changed: %q", got)
	}
}

func TestBatchRejectsCommandInjection(t *testing.T) {
	c := testBatch(t, "echo safe")
	for _, arg := range []string{"&whoami", "%PATH%", "hello\r\nwhoami", `"bad`, "|more"} {
		if _, err := commandFor(c, arg); err == nil {
			t.Fatalf("accepted %q", arg)
		}
	}
}

func TestRealOpenCodeVersionWhenRequested(t *testing.T) {
	if os.Getenv("WPS_TEST_REAL_OPENCODE") != "1" {
		t.Skip("opt-in installed OpenCode check")
	}
	c, found := discoverOpenCode()
	if !found {
		t.Fatal("OpenCode not found")
	}
	if c.cmd {
		t.Fatal("npm native executable was not selected")
	}
	if version := (&openCodeManager{}).version(c); version == "" {
		t.Fatal("installed OpenCode version query failed")
	}
	// Check that the original npm shim also works through the fallback path.
	shim := filepath.Join(os.Getenv("APPDATA"), "npm", "opencode.cmd")
	if _, err := os.Stat(shim); err == nil {
		if version := (&openCodeManager{}).version(opencodeCandidate{path: shim, cmd: true}); version == "" {
			t.Fatal("installed npm shim version query failed")
		}
	}
}

func TestOpenCodeEarlyExitIsReported(t *testing.T) {
	c := testBatch(t, "exit /b 1")
	t.Setenv("LOCALAPPDATA", t.TempDir())
	m := &openCodeManager{discover: func() (opencodeCandidate, bool) { return c, true },
		probe:      func() (bool, bool, string) { return false, false, "" },
		getVersion: func(opencodeCandidate) string { return "test" }, start: launchHidden,
		startupTimeout: 3 * time.Second, pollInterval: 10 * time.Millisecond}
	before := time.Now()
	state := m.startServer()
	if state.ErrorCode != "process_exited" || state.Managed || state.Detail == "" {
		t.Fatalf("wrong failure state: %#v", state)
	}
	if time.Since(before) >= 2*time.Second {
		t.Fatal("waited for timeout despite process exit")
	}
}
