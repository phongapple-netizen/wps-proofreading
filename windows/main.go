package main

import (
	"context"
	"embed"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// The build script copies the add-on files into assets before compiling.
//
//go:embed assets
var embedded embed.FS

const (
	port       = "3891"
	addonName  = "wps-text-proofreading"
	entry      = `  <jspluginonline name="wps-text-proofreading" type="wps" url="http://127.0.0.1:3891/" debug="" enable="enable_dev" install="null"/>`
	defaultXML = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n<jsplugins>\n</jsplugins>\n"
)

var pluginPattern = regexp.MustCompile(`(?is)\s*<jspluginonline\b[^>]*\bname\s*=\s*["'](?:wps-text-proofreading|wordollama-wps-native)["'][^>]*/>`)

func publishPath() (string, error) {
	appData := os.Getenv("APPDATA")
	if appData == "" {
		return "", errors.New("找不到 APPDATA，无法注册 WPS 加载项")
	}
	return filepath.Join(appData, "kingsoft", "wps", "jsaddons", "publish.xml"), nil
}

func updateXML(original string, install bool) (string, error) {
	if strings.TrimSpace(original) != "" {
		var doc struct {
			XMLName xml.Name `xml:"jsplugins"`
		}
		if err := xml.Unmarshal([]byte(original), &doc); err != nil || doc.XMLName.Local != "jsplugins" {
			return "", errors.New("publish.xml 结构异常；为保护其他加载项，未修改该文件")
		}
	}
	cleaned := pluginPattern.ReplaceAllString(original, "")
	if strings.TrimSpace(cleaned) == "" {
		if install {
			cleaned = defaultXML
		} else {
			return original, nil
		}
	}
	closing := strings.LastIndex(strings.ToLower(cleaned), "</jsplugins>")
	if closing < 0 {
		return "", errors.New("publish.xml 缺少 jsplugins 结束标签；为保护其他加载项，未修改该文件")
	}
	if !install {
		return cleaned, nil
	}
	return strings.TrimRight(cleaned[:closing], " \t\r\n") + "\n" + entry + "\n" + cleaned[closing:], nil
}

func register(install bool) error {
	filename, err := publishPath()
	if err != nil {
		return err
	}
	original, err := os.ReadFile(filename)
	if errors.Is(err, os.ErrNotExist) && !install {
		return nil
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	updated, err := updateXML(string(original), install)
	if err != nil {
		return err
	}
	if updated == string(original) {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(filename), 0o700); err != nil {
		return err
	}
	if len(original) > 0 {
		// This is the latest snapshot of the user's original WPS configuration.
		// Do not ignore backup failures or leave a stale first-install backup.
		if err := atomicWrite(filename+".wps-text-proofreading.bak", original, 0o600); err != nil {
			return err
		}
	}
	return atomicWrite(filename, []byte(updated), 0o600)
}

func atomicWrite(filename string, data []byte, mode os.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(filename), ".wps-proofreading-*.tmp")
	if err != nil {
		return err
	}
	name := tmp.Name()
	defer os.Remove(name)
	if err := tmp.Chmod(mode); err != nil {
		_ = tmp.Close()
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	// Preserve the original destination if replacement fails; register() has
	// already refreshed the user's backup before reaching this point.
	return os.Rename(name, filename)
}

func portAvailable() bool {
	listener, err := net.Listen("tcp", "127.0.0.1:"+port)
	if err != nil {
		return false
	}
	_ = listener.Close()
	return true
}

type opencodeState struct {
	State   string `json:"state"`
	Found   bool   `json:"found"`
	Version string `json:"version"`
	Managed bool   `json:"managed"`
}

type opencodeCandidate struct {
	path string
	cmd  bool
}

type boundedLog struct {
	mu   sync.Mutex
	file *os.File
	size int64
}

func (w *boundedLog) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	n := len(p)
	if w.file == nil {
		return n, nil
	}
	if w.size >= 1024*1024 {
		return n, nil
	}
	if int64(len(p)) > 1024*1024-w.size {
		p = p[:1024*1024-w.size]
	}
	written, err := w.file.Write(p)
	w.size += int64(written)
	if err != nil {
		return 0, err
	}
	return n, nil
}

func (w *boundedLog) Close() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.file != nil {
		_ = w.file.Close()
		w.file = nil
	}
}

type openCodeRun struct {
	process *os.Process
	output  *boundedLog
	done    chan struct{}
}

type openCodeManager struct {
	mu             sync.Mutex
	managed        bool
	run            *openCodeRun
	client         *http.Client
	healthURL      string
	portAddress    string
	lookup         func(string) (string, error)
	discover       func() (opencodeCandidate, bool)
	start          func(*exec.Cmd) (*os.Process, error)
	getVersion     func(opencodeCandidate) string
	probe          func() (bool, bool, string)
	startupTimeout time.Duration
	pollInterval   time.Duration
}

var opencode = &openCodeManager{client: &http.Client{Timeout: 1200 * time.Millisecond, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}, healthURL: "http://127.0.0.1:4096/global/health", portAddress: "127.0.0.1:4096", lookup: exec.LookPath, start: launchHidden, startupTimeout: 18 * time.Second, pollInterval: 350 * time.Millisecond}

func launchHidden(cmd *exec.Cmd) (*os.Process, error) {
	if err := startHidden(cmd); err != nil {
		return nil, err
	}
	return cmd.Process, nil
}

func candidateFrom(path string) (opencodeCandidate, bool) {
	if path == "" {
		return opencodeCandidate{}, false
	}
	ext := strings.ToLower(filepath.Ext(path))
	if ext != ".exe" && ext != ".cmd" {
		return opencodeCandidate{}, false
	}
	info, err := os.Stat(path)
	if err != nil || info.IsDir() {
		return opencodeCandidate{}, false
	}
	return opencodeCandidate{path: path, cmd: ext == ".cmd"}, true
}

func discoverOpenCode() (opencodeCandidate, bool) {
	return discoverFrom(opencode.lookup, os.Getenv("USERPROFILE"), os.Getenv("APPDATA"), os.Getenv("ProgramFiles"))
}

func discoverFrom(lookup func(string) (string, error), profile, appData, programFiles string) (opencodeCandidate, bool) {
	if lookup != nil {
		if found, err := lookup("opencode"); err == nil {
			if c, ok := candidateFrom(found); ok {
				return c, true
			}
		}
	}
	paths := []string{}
	for _, base := range []struct{ root, sub string }{{profile, ".opencode"}, {profile, ".local"}, {appData, "npm"}, {programFiles, "nodejs"}} {
		if base.root == "" {
			continue
		}
		if base.sub == ".opencode" || base.sub == ".local" {
			paths = append(paths, filepath.Join(base.root, base.sub, "bin", "opencode.exe"), filepath.Join(base.root, base.sub, "bin", "opencode.cmd"))
		} else {
			paths = append(paths, filepath.Join(base.root, base.sub, "opencode.exe"), filepath.Join(base.root, base.sub, "opencode.cmd"))
		}
	}
	for _, p := range paths {
		if c, ok := candidateFrom(p); ok {
			return c, true
		}
	}
	return opencodeCandidate{}, false
}

func commandFor(candidate opencodeCandidate, args ...string) (*exec.Cmd, error) {
	if !candidate.cmd {
		return exec.Command(candidate.path, args...), nil
	}
	// cmd.exe is needed for npm's opencode.cmd shim. Reject command metacharacters
	// in the discovered executable path; API callers can never supply this path.
	if strings.ContainsAny(candidate.path, "&|<>^%!()\"\r\n") {
		return nil, errors.New("OpenCode 路径包含不支持的字符")
	}
	command := `"` + candidate.path + `"`
	for _, arg := range args {
		if strings.ContainsAny(arg, "&|<>^%!\"\r\n") {
			return nil, errors.New("OpenCode 参数无效")
		}
		command += ` "` + arg + `"`
	}
	return exec.Command("cmd.exe", "/d", "/s", "/c", `"`+command+`"`), nil
}

func (m *openCodeManager) version(c opencodeCandidate) string {
	cmd, err := commandFor(c, "--version")
	if err != nil {
		return ""
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd = exec.CommandContext(ctx, cmd.Path, cmd.Args[1:]...)
	out, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
}

func (m *openCodeManager) health() (bool, bool, string) {
	if m.probe != nil {
		return m.probe()
	}
	resp, err := m.client.Get(m.healthURL)
	if err != nil {
		conn, dialErr := net.DialTimeout("tcp", m.portAddress, 250*time.Millisecond)
		if dialErr == nil {
			_ = conn.Close()
			return false, true, ""
		}
		return false, false, ""
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(resp.Body, 64*1024))
	var payload struct {
		Healthy bool   `json:"healthy"`
		Version string `json:"version"`
	}
	if resp.StatusCode >= 200 && resp.StatusCode < 300 && json.Unmarshal(body, &payload) == nil && payload.Healthy && strings.TrimSpace(payload.Version) != "" {
		return true, true, payload.Version
	}
	return false, true, ""
}

func (m *openCodeManager) status() opencodeState {
	discover := m.discover
	if discover == nil {
		discover = discoverOpenCode
	}
	c, found := discover()
	healthy, occupied, healthVersion := m.health()
	m.mu.Lock()
	managed := m.managed
	m.mu.Unlock()
	state := opencodeState{Found: found, Managed: managed}
	if found {
		version := m.getVersion
		if version == nil {
			version = m.version
		}
		state.Version = version(c)
	}
	if healthVersion != "" {
		state.Version = healthVersion
	}
	switch {
	case healthy:
		state.State = "ready"
	case occupied:
		state.State = "port_conflict"
	case !found:
		state.State = "missing"
	default:
		state.State = "stopped"
	}
	return state
}

func (m *openCodeManager) startServer() opencodeState {
	state := m.status()
	if state.State == "ready" || (state.State == "port_conflict" && !state.Managed) || state.State == "missing" {
		return state
	}
	discover := m.discover
	if discover == nil {
		discover = discoverOpenCode
	}
	c, found := discover()
	if !found {
		state.State = "missing"
		return state
	}
	m.mu.Lock()
	if m.managed {
		run := m.run
		m.mu.Unlock()
		return m.waitReady(c, run)
	}
	cmd, err := commandFor(c, "serve", "--hostname", "127.0.0.1", "--port", "4096", "--cors", "http://127.0.0.1:3891")
	if err != nil {
		m.mu.Unlock()
		state.State = "error"
		return state
	}
	logPath := filepath.Join(os.Getenv("LOCALAPPDATA"), "WPSProofreading", "opencode.log")
	if err := os.MkdirAll(filepath.Dir(logPath), 0o700); err != nil {
		m.mu.Unlock()
		state.State = "error"
		return state
	}
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		m.mu.Unlock()
		state.State = "error"
		return state
	}
	output := &boundedLog{file: logFile}
	cmd.Stdout, cmd.Stderr = output, output
	cmd.WaitDelay = time.Second
	process, err := m.start(cmd)
	if err != nil || process == nil {
		output.Close()
		m.mu.Unlock()
		state.State = "error"
		return state
	}
	run := &openCodeRun{process: process, output: output, done: make(chan struct{})}
	m.run, m.managed = run, true
	go func() {
		_ = cmd.Wait()
		output.Close()
		close(run.done)
		m.mu.Lock()
		if m.run == run {
			m.managed, m.run = false, nil
		}
		m.mu.Unlock()
	}()
	m.mu.Unlock()
	return m.waitReady(c, run)
}

func (m *openCodeManager) stopManaged(run *openCodeRun) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if run == nil || m.run != run {
		return
	}
	// Only terminate the exact process tree started by this manager. Wait closes
	// done before acquiring mu, so cleanup can finish before another retry starts.
	select {
	case <-run.done:
	default:
		_ = killManagedProcess(run.process)
	}
	select {
	case <-run.done:
	case <-time.After(2 * time.Second):
	}
	run.output.Close()
	m.managed, m.run = false, nil
}

func (m *openCodeManager) waitReady(c opencodeCandidate, run *openCodeRun) opencodeState {
	versionFn := m.getVersion
	if versionFn == nil {
		versionFn = m.version
	}
	timeout, interval := m.startupTimeout, m.pollInterval
	if timeout <= 0 {
		timeout = 18 * time.Second
	}
	if interval <= 0 {
		interval = 350 * time.Millisecond
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if healthy, _, version := m.health(); healthy {
			return opencodeState{State: "ready", Found: true, Version: firstNonempty(version, versionFn(c)), Managed: m.isManaged()}
		}
		// Our process may bind the port before its health endpoint is ready.
		time.Sleep(interval)
	}
	m.stopManaged(run)
	return opencodeState{State: "error", Found: true, Version: versionFn(c), Managed: m.isManaged()}
}
func firstNonempty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
func (m *openCodeManager) isManaged() bool { m.mu.Lock(); defer m.mu.Unlock(); return m.managed }

type runValue struct {
	present     bool
	kind, value string
}

func readRunValue() (runValue, error) {
	key := `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
	out, err := exec.Command("reg.exe", "query", key, "/v", "WPSProofreading").CombinedOutput()
	if err != nil {
		msg := strings.ToLower(string(out))
		if strings.Contains(msg, "unable to find") || strings.Contains(msg, "cannot find") || strings.Contains(msg, "找不到") {
			return runValue{}, nil
		}
		return runValue{}, fmt.Errorf("无法读取现有自启动项: %w", err)
	}
	for _, line := range strings.Split(string(out), "\n") {
		fields := strings.Fields(line)
		if len(fields) >= 3 && strings.EqualFold(fields[0], "WPSProofreading") {
			index := strings.Index(line, fields[1])
			if index < 0 {
				continue
			}
			dataStart := index + len(fields[1])
			return runValue{present: true, kind: fields[1], value: strings.TrimSpace(line[dataStart:])}, nil
		}
	}
	return runValue{}, errors.New("无法解析现有 WPSProofreading 自启动项")
}

func writeRunValue(value runValue) error {
	key := `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`
	if !value.present {
		out, err := exec.Command("reg.exe", "delete", key, "/v", "WPSProofreading", "/f").CombinedOutput()
		if err != nil {
			msg := strings.ToLower(string(out))
			if strings.Contains(msg, "unable to find") || strings.Contains(msg, "cannot find") || strings.Contains(msg, "找不到") {
				return nil
			}
			return fmt.Errorf("无法删除 WPSProofreading 自启动项: %w", err)
		}
		return nil
	}
	cmd := exec.Command("reg.exe", "add", key, "/v", "WPSProofreading", "/t", value.kind, "/d", value.value, "/f")
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("无法写入 WPSProofreading 自启动项: %w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

func runRegistry(set bool) error {
	if !set {
		return writeRunValue(runValue{})
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	return writeRunValue(runValue{present: true, kind: "REG_SZ", value: `"` + executable + `" --serve`})
}

// installSteps keeps the externally visible install order explicit and lets
// tests exercise rollback without touching the real registry or starting a
// Windows service process.
func installSteps(registerStep func() error, startStep func() (func() error, error), healthStep func() error, runStep func() error, rollback func(func() error) error) error {
	if err := registerStep(); err != nil {
		if rbErr := rollback(nil); rbErr != nil {
			return fmt.Errorf("注册 WPS 加载项失败，且回滚失败: %v; %w", rbErr, err)
		}
		return fmt.Errorf("注册 WPS 加载项失败，已回滚: %w", err)
	}
	stop, err := startStep()
	if err != nil {
		if rbErr := rollback(nil); rbErr != nil {
			return fmt.Errorf("本地服务启动失败，且回滚失败: %v; %w", rbErr, err)
		}
		return fmt.Errorf("本地服务启动失败，已回滚: %w", err)
	}
	if err := healthStep(); err != nil {
		if rbErr := rollback(stop); rbErr != nil {
			return fmt.Errorf("本地服务健康检查失败，且回滚失败: %v; %w", rbErr, err)
		}
		return fmt.Errorf("本地服务健康检查失败，已回滚: %w", err)
	}
	if err := runStep(); err != nil {
		if rbErr := rollback(stop); rbErr != nil {
			return fmt.Errorf("写入自启动项失败，且回滚失败: %v; %w", rbErr, err)
		}
		return fmt.Errorf("写入自启动项失败，已回滚: %w", err)
	}
	return nil
}

func install() error {
	if !portAvailable() {
		return errors.New("端口 3891 已被占用，未写入 WPS 注册项")
	}
	addon, err := fs.Sub(embedded, "assets")
	if err != nil {
		return fmt.Errorf("安装文件不完整: %w", err)
	}
	for _, name := range []string{"index.html", "main.js", "ribbon.xml", "package.json", "ui/taskpane.html", "ui/taskpane.css", "js/taskpane.js", "js/proofreading-integration.js", "js/opencode-client.js", "rules/catalog.json"} {
		if _, err := fs.ReadFile(addon, name); err != nil {
			return fmt.Errorf("安装文件不完整（%s）: %w", name, err)
		}
	}
	filename, err := publishPath()
	if err != nil {
		return err
	}
	original, readErr := os.ReadFile(filename)
	hadFile := readErr == nil
	originalMode := os.FileMode(0o600)
	if hadFile {
		if info, statErr := os.Stat(filename); statErr == nil {
			originalMode = info.Mode().Perm()
		}
	}
	if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
		return readErr
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	expectedXML, err := updateXML(string(original), true)
	if err != nil {
		return fmt.Errorf("无法安全更新 WPS 注册项: %w", err)
	}
	oldRun, err := readRunValue()
	if err != nil {
		return err
	}
	rollback := func(stop func() error) error {
		var failures []string
		currentXML, e := os.ReadFile(filename)
		if e == nil {
			if string(currentXML) == expectedXML {
				if hadFile {
					e = atomicWrite(filename, original, originalMode)
				} else {
					e = os.Remove(filename)
					if errors.Is(e, os.ErrNotExist) {
						e = nil
					}
				}
			} else {
				// Preserve concurrent changes by removing only this add-on's entry.
				var cleaned string
				cleaned, e = updateXML(string(currentXML), false)
				if e == nil && cleaned != string(currentXML) {
					info, statErr := os.Stat(filename)
					mode := os.FileMode(0o600)
					if statErr == nil {
						mode = info.Mode().Perm()
					}
					e = atomicWrite(filename, []byte(cleaned), mode)
				}
			}
			if e != nil {
				failures = append(failures, "恢复本插件 publish.xml 注册状态失败: "+e.Error())
			}
		} else if !errors.Is(e, os.ErrNotExist) {
			failures = append(failures, "读取 publish.xml 以执行回滚失败: "+e.Error())
		} else if !hadFile {
			_ = os.Remove(filepath.Dir(filename))
		}
		targetRun := runValue{present: true, kind: "REG_SZ", value: `"` + executable + `" --serve`}
		currentRun, runErr := readRunValue()
		if runErr != nil {
			failures = append(failures, "读取自启动项以执行回滚失败: "+runErr.Error())
		} else if currentRun != oldRun {
			if currentRun == targetRun {
				if e := writeRunValue(oldRun); e != nil {
					failures = append(failures, "恢复原自启动项失败: "+e.Error())
				}
			} else {
				failures = append(failures, "自启动项在安装期间发生变化，已保留该项且未覆盖")
			}
		}
		if stop != nil {
			if e := stop(); e != nil {
				failures = append(failures, "停止本次服务失败: "+e.Error())
			}
		}
		if len(failures) > 0 {
			return errors.New(strings.Join(failures, "; "))
		}
		return nil
	}
	var exited <-chan error
	var service *os.Process
	startStep := func() (func() error, error) {
		cmd := exec.Command(executable, "--serve")
		if err := startHidden(cmd); err != nil {
			return nil, err
		}
		service = cmd.Process
		exitSignal := make(chan error, 1)
		exited = exitSignal
		go func() { exitSignal <- cmd.Wait() }()
		return func() error {
			if e := service.Kill(); e != nil && !errors.Is(e, os.ErrProcessDone) {
				return e
			}
			return nil
		}, nil
	}
	healthStep := func() error {
		deadline := time.Now().Add(12 * time.Second)
		for time.Now().Before(deadline) {
			client := http.Client{Timeout: 400 * time.Millisecond, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
			resp, reqErr := client.Get("http://127.0.0.1:3891/api/health")
			if reqErr == nil {
				body, _ := io.ReadAll(io.LimitReader(resp.Body, 256))
				ok := resp.StatusCode == http.StatusOK && strings.TrimSpace(string(body)) == `{"service":"wps-proofreading","port":3891}`
				_ = resp.Body.Close()
				if ok {
					return nil
				}
			}
			select {
			case <-exited:
				return errors.New("本地服务启动后立即退出")
			default:
			}
			time.Sleep(250 * time.Millisecond)
		}
		return errors.New("本地服务健康检查超时")
	}
	runStep := func() error {
		return writeRunValue(runValue{present: true, kind: "REG_SZ", value: `"` + executable + `" --serve`})
	}
	return installSteps(func() error { return register(true) }, startStep, healthStep, runStep, rollback)
}

func uninstall() error {
	var errs []string
	if err := register(false); err != nil {
		errs = append(errs, "移除 WPS 注册项失败: "+err.Error())
	}
	if err := runRegistry(false); err != nil {
		errs = append(errs, err.Error())
	}
	if len(errs) > 0 {
		return errors.New(strings.Join(errs, "; "))
	}
	return nil
}

func opencodeAPI(w http.ResponseWriter, r *http.Request) bool {
	if r.URL.Path != "/api/opencode/status" && r.URL.Path != "/api/opencode/start" {
		return false
	}
	if r.URL.Path == "/api/opencode/status" && r.Method != http.MethodGet {
		http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
		return true
	}
	if r.URL.Path == "/api/opencode/start" {
		if r.Method != http.MethodPost {
			http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
			return true
		}
		if r.Header.Get("Origin") != "http://127.0.0.1:3891" || r.Header.Get("Sec-Fetch-Site") == "cross-site" {
			http.Error(w, "Forbidden", http.StatusForbidden)
			return true
		}
	}
	var state opencodeState
	if r.URL.Path == "/api/opencode/start" {
		state = opencode.startServer()
	} else {
		state = opencode.status()
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(state)
	return true
}

func handler(addon fs.FS) http.Handler {
	mimes := map[string]string{
		".html": "text/html; charset=utf-8",
		".css":  "text/css; charset=utf-8",
		".js":   "application/javascript; charset=utf-8",
		".json": "application/json; charset=utf-8",
		".xml":  "application/xml; charset=utf-8",
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Host != "127.0.0.1:"+port {
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}
		if opencodeAPI(w, r) {
			return
		}
		if r.URL.Path == "/api/health" {
			if r.Method != http.MethodGet {
				http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
				return
			}
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			w.Header().Set("Cache-Control", "no-store")
			_, _ = w.Write([]byte(`{"service":"wps-proofreading","port":3891}`))
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "Method Not Allowed", http.StatusMethodNotAllowed)
			return
		}
		name := strings.TrimPrefix(path.Clean(r.URL.Path), "/")
		if r.URL.Path == "/" {
			name = "index.html"
		}
		parts := strings.Split(name, "/")
		if name == "." || strings.Contains(name, "\\") ||
			strings.Contains(r.URL.EscapedPath(), "%2e") || strings.Contains(r.URL.EscapedPath(), "%2E") {
			http.Error(w, "Bad Request", http.StatusBadRequest)
			return
		}
		for _, part := range parts {
			if part == "" || strings.HasPrefix(part, ".") {
				http.Error(w, "Bad Request", http.StatusBadRequest)
				return
			}
		}
		allowedRoot := map[string]bool{"index.html": true, "main.js": true, "ribbon.xml": true, "package.json": true}
		allowedDir := map[string]bool{"js": true, "ui": true, "rules": true}
		if !allowedRoot[name] && !allowedDir[parts[0]] {
			http.Error(w, "Bad Request", http.StatusBadRequest)
			return
		}
		mime, ok := mimes[path.Ext(name)]
		if !ok {
			http.Error(w, "Bad Request", http.StatusBadRequest)
			return
		}
		data, err := fs.ReadFile(addon, name)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", mime)
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Length", fmt.Sprint(len(data)))
		if r.Method != http.MethodHead {
			_, _ = w.Write(data)
		}
	})
}

func serve() error {
	addon, err := fs.Sub(embedded, "assets")
	if err != nil {
		return err
	}
	server := &http.Server{
		Addr:              "127.0.0.1:" + port,
		Handler:           handler(addon),
		ReadHeaderTimeout: 5 * time.Second,
	}
	return server.ListenAndServe()
}

func selfTest() error {
	original := `<?xml version="1.0"?><jsplugins><jspluginonline name="other-addon" url="https://example.test/"/><jspluginonline name="wordollama-wps-native"/></jsplugins>`
	added, err := updateXML(original, true)
	if err != nil {
		return err
	}
	repeated, err := updateXML(added, true)
	if err != nil {
		return err
	}
	removed, err := updateXML(repeated, false)
	removedAgain, removeAgainErr := updateXML(removed, false)
	if err != nil || removeAgainErr != nil || added != repeated || removed != removedAgain || strings.Contains(removed, addonName) || strings.Contains(removed, "wordollama-wps-native") || !strings.Contains(removed, "other-addon") {
		return errors.New("WPS 注册项自检失败")
	}
	for _, damaged := range []string{`<jsplugins><jspluginonline name="other"/>`, `<jsplugins><bad></jsplugins>`, `<other></other>`} {
		if _, err := updateXML(damaged, true); err == nil {
			return errors.New("损坏的 publish.xml 未被拒绝")
		}
		if _, err := updateXML(damaged, false); err == nil {
			return errors.New("卸载时损坏的 publish.xml 未被拒绝")
		}
	}
	addon, err := fs.Sub(embedded, "assets")
	if err != nil {
		return err
	}
	if _, err := fs.ReadFile(addon, "index.html"); err != nil {
		return err
	}
	return nil
}

func main() {
	var err error
	if len(os.Args) > 1 {
		switch os.Args[1] {
		case "--register":
			err = register(true)
		case "--unregister":
			err = register(false)
		case "--install":
			err = install()
		case "--uninstall":
			err = uninstall()
		case "--check-port":
			if !portAvailable() {
				err = errors.New("端口 3891 已被占用")
			}
		case "--self-test":
			err = selfTest()
		case "--serve":
			err = serve()
		default:
			err = errors.New("未知参数")
		}
	} else {
		err = serve()
	}
	if err != nil {
		logPath := filepath.Join(os.Getenv("LOCALAPPDATA"), "WPSProofreading", "service-error.log")
		if mkErr := os.MkdirAll(filepath.Dir(logPath), 0o700); mkErr == nil {
			_ = os.WriteFile(logPath, []byte(err.Error()+"\n"), 0o600)
		}
		log.Print(err)
		os.Exit(1)
	}
}
