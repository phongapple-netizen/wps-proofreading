package main

import (
	"embed"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// The build script copies the add-on files into assets before compiling.
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
	cleaned := pluginPattern.ReplaceAllString(original, "")
	if !install {
		return cleaned, nil
	}
	if strings.TrimSpace(cleaned) == "" {
		cleaned = defaultXML
	}
	closing := strings.LastIndex(strings.ToLower(cleaned), "</jsplugins>")
	if closing < 0 {
		return "", errors.New("publish.xml 缺少 jsplugins 结束标签；为保护其他加载项，未修改该文件")
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
		if err := os.WriteFile(filename+".wps-text-proofreading.bak", original, 0o600); err != nil {
			return err
		}
	}
	return os.WriteFile(filename, []byte(updated), 0o600)
}

func portAvailable() bool {
	listener, err := net.Listen("tcp", "127.0.0.1:"+port)
	if err != nil {
		return false
	}
	_ = listener.Close()
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
	original := `<?xml version="1.0"?><jsplugins><jspluginonline name="other-addon" url="https://example.test/"/></jsplugins>`
	added, err := updateXML(original, true)
	if err != nil {
		return err
	}
	repeated, err := updateXML(added, true)
	if err != nil {
		return err
	}
	removed, err := updateXML(repeated, false)
	if err != nil || added != repeated || strings.Contains(removed, addonName) || !strings.Contains(removed, "other-addon") {
		return errors.New("WPS 注册项自检失败")
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
