package main

import (
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func touch(t *testing.T, filename string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(filename), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filename, []byte("fake executable"), 0o700); err != nil {
		t.Fatal(err)
	}
	return filename
}

func TestPublishXMLSafetyAndIdempotence(t *testing.T) {
	original := `<?xml version="1.0"?><jsplugins><jspluginonline name="one"/><jspluginonline name="wps-text-proofreading"/><jspluginonline name="two"/><jspluginonline name="wordollama-wps-native"/></jsplugins>`
	added, err := updateXML(original, true)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Count(added, `name="wps-text-proofreading"`) != 1 || !strings.Contains(added, `name="one"`) || !strings.Contains(added, `name="two"`) {
		t.Fatalf("other registrations not preserved: %s", added)
	}
	repeated, err := updateXML(added, true)
	if err != nil || repeated != added {
		t.Fatalf("install not idempotent: %v", err)
	}
	removed, err := updateXML(repeated, false)
	if err != nil {
		t.Fatal(err)
	}
	removedAgain, err := updateXML(removed, false)
	if err != nil || removedAgain != removed {
		t.Fatalf("uninstall not idempotent: %v", err)
	}
	if strings.Contains(removed, addonName) || strings.Contains(removed, "wordollama-wps-native") || !strings.Contains(removed, `name="one"`) || !strings.Contains(removed, `name="two"`) {
		t.Fatalf("unexpected uninstall result: %s", removed)
	}
}

func TestPublishXMLRejectsDamagedAndMalformed(t *testing.T) {
	for _, input := range []string{`<jsplugins><jspluginonline name="other"/>`, `<jsplugins><broken></jsplugins>`, `<wrong></wrong>`} {
		if _, err := updateXML(input, true); err == nil {
			t.Errorf("install accepted invalid XML %q", input)
		}
		if _, err := updateXML(input, false); err == nil {
			t.Errorf("uninstall accepted invalid XML %q", input)
		}
	}
	for _, empty := range []string{"", " \n\t"} {
		updated, err := updateXML(empty, true)
		if err != nil || !strings.Contains(updated, "<jsplugins>") {
			t.Fatalf("empty document creation failed: %v", err)
		}
	}
}

func TestRegisterRefreshesBackupAndRefusesDamage(t *testing.T) {
	appData := t.TempDir()
	t.Setenv("APPDATA", appData)
	filename := filepath.Join(appData, "kingsoft", "wps", "jsaddons", "publish.xml")
	first := `<jsplugins><jspluginonline name="first"/></jsplugins>`
	if err := os.MkdirAll(filepath.Dir(filename), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filename, []byte(first), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := register(true); err != nil {
		t.Fatal(err)
	}
	backup, err := os.ReadFile(filename + ".wps-text-proofreading.bak")
	if err != nil || string(backup) != first {
		t.Fatalf("backup missing/stale: %q %v", backup, err)
	}
	second := `<jsplugins><jspluginonline name="second"/></jsplugins>`
	if err := os.WriteFile(filename, []byte(second), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := register(true); err != nil {
		t.Fatal(err)
	}
	backup, err = os.ReadFile(filename + ".wps-text-proofreading.bak")
	if err != nil || string(backup) != second {
		t.Fatalf("backup not refreshed: %q %v", backup, err)
	}
	damaged := `<jsplugins><jspluginonline name="untouched"/>`
	if err := os.WriteFile(filename, []byte(damaged), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := register(true); err == nil {
		t.Fatal("expected malformed configuration to be rejected")
	}
	current, err := os.ReadFile(filename)
	if err != nil || string(current) != damaged {
		t.Fatal("damaged source was changed")
	}
}

func TestWindowsOpenCodeDiscoveryPriority(t *testing.T) {
	root := t.TempDir()
	profile, appData, programs := filepath.Join(root, "profile"), filepath.Join(root, "appdata"), filepath.Join(root, "programs")
	local := touch(t, filepath.Join(profile, ".opencode", "bin", "opencode.exe"))
	npm := touch(t, filepath.Join(appData, "npm", "opencode.cmd"))
	pathCandidate := touch(t, filepath.Join(root, "path", "opencode.exe"))
	lookup := func(name string) (string, error) {
		if name == "opencode" {
			return pathCandidate, nil
		}
		return "", errors.New("not found")
	}
	got, ok := discoverFrom(lookup, profile, appData, programs)
	if !ok || got.path != pathCandidate {
		t.Fatalf("PATH should win: %#v", got)
	}
	got, ok = discoverFrom(func(string) (string, error) { return "", errors.New("not found") }, profile, appData, programs)
	if !ok || got.path != local {
		t.Fatalf(".opencode/bin should precede npm: %#v", got)
	}
	_ = os.Remove(local)
	got, ok = discoverFrom(nil, profile, appData, programs)
	if !ok || got.path != npm || !got.cmd {
		t.Fatalf("npm shim not found: %#v", got)
	}
	if _, ok := discoverFrom(nil, filepath.Join(root, "absent"), filepath.Join(root, "absent2"), programs); ok {
		t.Fatal("unexpected executable discovery")
	}
}

func TestOpenCodeHealthStates(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	addr := listener.Addr().String()
	_ = listener.Close()
	m := &openCodeManager{client: &http.Client{Timeout: 30 * time.Millisecond}, healthURL: "http://" + addr + "/global/health", portAddress: addr}
	if _, occupied, _ := m.health(); occupied {
		t.Fatal("closed port should be absent")
	}
	for _, tc := range []struct {
		name, body        string
		code              int
		delay             time.Duration
		healthy, occupied bool
	}{
		{"ready", `{"healthy":true,"version":"1.2.3"}`, 200, 0, true, true},
		{"non-opencode", `{"healthy":false}`, 200, 0, false, true},
		{"http-error", `{}`, 500, 0, false, true},
		{"timeout", `{"healthy":true}`, 200, 80 * time.Millisecond, false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				time.Sleep(tc.delay)
				w.WriteHeader(tc.code)
				_, _ = w.Write([]byte(tc.body))
			}))
			defer srv.Close()
			m.healthURL = srv.URL
			m.portAddress = strings.TrimPrefix(srv.URL, "http://")
			healthy, occupied, version := m.health()
			if healthy != tc.healthy || occupied != tc.occupied {
				t.Fatalf("health=(%v,%v), want (%v,%v)", healthy, occupied, tc.healthy, tc.occupied)
			}
			if tc.name == "ready" && version != "1.2.3" {
				t.Fatalf("version %q", version)
			}
		})
	}
}

func TestNpmDiscoveryPrefersNativeExecutable(t *testing.T) {
	root := t.TempDir()
	shim := touch(t, filepath.Join(root, "npm with spaces", "opencode.cmd"))
	native := touch(t, filepath.Join(filepath.Dir(shim), "node_modules", "opencode-ai", "bin", "opencode.exe"))
	got, ok := discoverFrom(func(string) (string, error) { return shim, nil }, "", "", "")
	if !ok || got.path != native || got.cmd {
		t.Fatalf("native binary not preferred: %#v", got)
	}
	if err := os.Remove(native); err != nil {
		t.Fatal(err)
	}
	got, ok = candidateFrom(shim)
	if !ok || got.path != shim || !got.cmd {
		t.Fatalf("batch fallback lost: %#v", got)
	}
}

func managerForStart(t *testing.T, state func() (bool, bool, string), start func() error) (*openCodeManager, string) {
	t.Helper()
	root := t.TempDir()
	candidate := touch(t, filepath.Join(root, "opencode.exe"))
	t.Setenv("LOCALAPPDATA", root)
	m := &openCodeManager{client: &http.Client{Timeout: 10 * time.Millisecond}, healthURL: "http://127.0.0.1:9/global/health", portAddress: "127.0.0.1:9", startupTimeout: 25 * time.Millisecond, pollInterval: 2 * time.Millisecond, discover: func() (opencodeCandidate, bool) { return opencodeCandidate{path: candidate}, true }, getVersion: func(opencodeCandidate) string { return "v-test" }, probe: state}
	m.start = func(cmd *exec.Cmd) (*os.Process, error) {
		if err := start(); err != nil {
			return nil, err
		}
		executable, err := os.Executable()
		if err != nil {
			return nil, err
		}
		cmd.Path, cmd.Args = executable, []string{executable, "-test.run=^TestOpenCodeHelperProcess$"}
		cmd.Env = append(os.Environ(), "WPS_OPENCODE_TEST_HELPER=1")
		if err := cmd.Start(); err != nil {
			return nil, err
		}
		return cmd.Process, nil
	}
	t.Cleanup(func() {
		m.mu.Lock()
		run := m.run
		m.mu.Unlock()
		m.stopManaged(run)
	})
	return m, candidate
}

func TestOpenCodeHelperProcess(t *testing.T) {
	if os.Getenv("WPS_OPENCODE_TEST_HELPER") == "1" {
		time.Sleep(time.Minute)
		os.Exit(0)
	}
}

func TestOpenCodeStartLifecycle(t *testing.T) {
	t.Run("started and healthy", func(t *testing.T) {
		calls := 0
		m, _ := managerForStart(t, func() (bool, bool, string) { calls++; return calls > 1, false, "v-test" }, func() error { return nil })
		got := m.startServer()
		if got.State != "ready" || !got.Managed {
			t.Fatalf("state %#v", got)
		}
	})
	t.Run("existing user instance not relaunched", func(t *testing.T) {
		launched := false
		m, _ := managerForStart(t, func() (bool, bool, string) { return true, false, "v-user" }, func() error { launched = true; return nil })
		got := m.startServer()
		if got.State != "ready" || got.Managed || launched {
			t.Fatalf("state %#v launched %v", got, launched)
		}
	})
	t.Run("launch failure", func(t *testing.T) {
		m, _ := managerForStart(t, func() (bool, bool, string) { return false, false, "" }, func() error { return errors.New("launch failed") })
		got := m.startServer()
		if got.State != "error" {
			t.Fatalf("state %#v", got)
		}
	})
	t.Run("startup timeout", func(t *testing.T) {
		launches := 0
		m, _ := managerForStart(t, func() (bool, bool, string) { return false, false, "" }, func() error { launches++; return nil })
		m.probe = func() (bool, bool, string) { return launches > 1, m.isManaged(), "v-test" }
		var started *exec.Cmd
		launch := m.start
		m.start = func(cmd *exec.Cmd) (*os.Process, error) { started = cmd; return launch(cmd) }
		got := m.startServer()
		if got.State != "error" || got.Managed || m.run != nil || started.ProcessState == nil {
			t.Fatalf("state %#v", got)
		}
		logPath := filepath.Join(os.Getenv("LOCALAPPDATA"), "WPSProofreading", "opencode.log")
		if err := os.Remove(logPath); err != nil {
			t.Fatalf("timeout left the log open: %v", err)
		}
		if retry := m.startServer(); retry.State != "ready" || !retry.Managed || launches != 2 {
			t.Fatalf("retry did not launch a fresh process: %#v launches=%d", retry, launches)
		}
	})
	t.Run("occupied port", func(t *testing.T) {
		launched := false
		m, _ := managerForStart(t, func() (bool, bool, string) { return false, true, "" }, func() error { launched = true; return nil })
		got := m.startServer()
		if got.State != "port_conflict" || launched {
			t.Fatalf("state %#v launched %v", got, launched)
		}
	})
	t.Run("already managed", func(t *testing.T) {
		calls := 0
		m, _ := managerForStart(t, func() (bool, bool, string) { calls++; return calls > 1, false, "" }, func() error { return nil })
		if got := m.startServer(); got.State != "ready" {
			t.Fatalf("initial start: %#v", got)
		}
		launches := 0
		m.start = func(*exec.Cmd) (*os.Process, error) { launches++; return nil, errors.New("must not relaunch") }
		calls = 0
		m.probe = func() (bool, bool, string) { calls++; return calls > 2, true, "v-test" }
		got := m.startServer()
		if got.State != "ready" || !got.Managed || launches != 0 {
			t.Fatalf("state %#v", got)
		}
	})
	t.Run("bound port waits for health after launch", func(t *testing.T) {
		calls, launches := 0, 0
		m, _ := managerForStart(t, func() (bool, bool, string) { calls++; return calls > 3, calls > 1, "v-test" }, func() error { launches++; return nil })
		if got := m.startServer(); got.State != "ready" || !got.Managed || launches != 1 {
			t.Fatalf("startup listener misclassified: %#v launches=%d", got, launches)
		}
	})
	t.Run("nil successful launch is rejected and closes log", func(t *testing.T) {
		m, _ := managerForStart(t, func() (bool, bool, string) { return false, false, "" }, func() error { return nil })
		m.start = func(*exec.Cmd) (*os.Process, error) { return nil, nil }
		if got := m.startServer(); got.State != "error" || got.Managed || m.run != nil {
			t.Fatalf("invalid launch accepted: %#v", got)
		}
		if err := os.Remove(filepath.Join(os.Getenv("LOCALAPPDATA"), "WPSProofreading", "opencode.log")); err != nil {
			t.Fatalf("nil launch left the log open: %v", err)
		}
	})
	t.Run("not installed", func(t *testing.T) {
		m, _ := managerForStart(t, func() (bool, bool, string) { return false, false, "" }, func() error { t.Fatal("should not launch"); return nil })
		m.discover = func() (opencodeCandidate, bool) { return opencodeCandidate{}, false }
		if got := m.startServer(); got.State != "missing" {
			t.Fatalf("state %#v", got)
		}
	})
}

func TestOpenCodeAPIGuardsAndSchema(t *testing.T) {
	old := opencode
	defer func() { opencode = old }()
	opencode = &openCodeManager{client: &http.Client{}, probe: func() (bool, bool, string) { return false, false, "" }, discover: func() (opencodeCandidate, bool) { return opencodeCandidate{}, false }}
	r := httptest.NewRequest(http.MethodPost, "/api/opencode/start", nil)
	r.Header.Set("Origin", "https://attacker.example")
	w := httptest.NewRecorder()
	if !opencodeAPI(w, r) || w.Code != http.StatusForbidden {
		t.Fatalf("cross-origin start accepted: %d", w.Code)
	}
	r = httptest.NewRequest(http.MethodGet, "/api/opencode/status", nil)
	w = httptest.NewRecorder()
	if !opencodeAPI(w, r) || w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"state":"missing"`) || strings.Contains(w.Body.String(), "path") {
		t.Fatalf("unexpected status API: %d %s", w.Code, w.Body.String())
	}
}

func TestBoundedLog(t *testing.T) {
	f, err := os.CreateTemp(t.TempDir(), "log")
	if err != nil {
		t.Fatal(err)
	}
	defer f.Close()
	writer := &boundedLog{file: f}
	payload := strings.Repeat("x", 1024*1024+32)
	n, err := writer.Write([]byte(payload))
	if err != nil || n != len(payload) || writer.size != 1024*1024 {
		t.Fatalf("bounded write n=%d size=%d err=%v", n, writer.size, err)
	}
}

func TestInstallStepsRollbackOnServiceStartFailure(t *testing.T) {
	oldXML, oldRun := `<jsplugins><jspluginonline name="other"/></jsplugins>`, `"old-server.exe" --serve`
	currentXML, currentRun := oldXML, oldRun
	var order []string
	rollback := func(stop func() error) error {
		order = append(order, "rollback")
		if stop != nil {
			t.Fatal("start failure must not stop a service that never started")
		}
		currentXML, currentRun = oldXML, oldRun
		return nil
	}
	err := installSteps(
		func() error {
			order = append(order, "register")
			currentXML = `<jsplugins><jspluginonline name="other"/><jspluginonline name="wps-text-proofreading"/></jsplugins>`
			return nil
		},
		func() (func() error, error) {
			order = append(order, "start")
			return nil, errors.New("fake process launch failure")
		},
		func() error { order = append(order, "health"); return nil },
		func() error { order = append(order, "run"); return nil }, rollback)
	if err == nil {
		t.Fatal("expected service startup failure")
	}
	if got := strings.Join(order, ","); got != "register,start,rollback" {
		t.Fatalf("install order %s", got)
	}
	if currentXML != oldXML || currentRun != oldRun {
		t.Fatalf("failed start left state changed: XML=%q Run=%q", currentXML, currentRun)
	}
}

func TestInstallStepsRollbackOnRunEntryFailure(t *testing.T) {
	oldXML, oldRun := `<jsplugins><jspluginonline name="other"/></jsplugins>`, `"old-server.exe" --serve`
	currentXML, currentRun := oldXML, oldRun
	var order []string
	rollback := func(stop func() error) error {
		if stop == nil {
			t.Fatal("started service cleanup was not passed to rollback")
		}
		order = append(order, "stop")
		if err := stop(); err != nil {
			return err
		}
		order = append(order, "restore")
		currentXML, currentRun = oldXML, oldRun
		return nil
	}
	err := installSteps(
		func() error {
			order = append(order, "register")
			currentXML = `<jsplugins><jspluginonline name="other"/><jspluginonline name="wps-text-proofreading"/></jsplugins>`
			return nil
		},
		func() (func() error, error) { order = append(order, "start"); return func() error { return nil }, nil },
		func() error { order = append(order, "health"); return nil },
		func() error {
			order = append(order, "run")
			currentRun = `"new-server.exe" --serve`
			return errors.New("fake Run registry write failure")
		}, rollback)
	if err == nil {
		t.Fatal("expected Run entry failure")
	}
	if got := strings.Join(order, ","); got != "register,start,health,run,stop,restore" {
		t.Fatalf("install order %s", got)
	}
	if currentXML != oldXML || currentRun != oldRun {
		t.Fatalf("failed Run write left state changed: XML=%q Run=%q", currentXML, currentRun)
	}
}
