//go:build windows

package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"math/rand"
	"os"
	"strings"
	"syscall"
	"testing"
	"unsafe"
)

const testRegistryRoot = `Software\WPSProofreadingTests`

const keyReadControl = 0x00020000

var regDeleteKeyW = advapi32.NewProc("RegDeleteKeyW")

func registryTestPath(t *testing.T) string {
	t.Helper()
	path := fmt.Sprintf(`%s\%x-%x`, testRegistryRoot, uint64(os.Getpid()), rand.Uint64())
	t.Cleanup(func() {
		if err := deleteRegistryTestKey(path); err != nil {
			t.Errorf("delete temporary registry key %q: %v", path, err)
		}
	})
	return path
}

func deleteRegistryTestKey(path string) error {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	status, _, _ := regDeleteKeyW.Call(uintptr(syscall.HKEY_CURRENT_USER), uintptr(unsafe.Pointer(name)))
	err = registryStatus(status)
	if errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) {
		return nil
	}
	return err
}

func TestRegistryRunValueMissingAndEmpty(t *testing.T) {
	path := registryTestPath(t)
	got, err := readRunValueAt(path)
	if err != nil || got.present {
		t.Fatalf("missing key read = %#v, %v; want absent", got, err)
	}
	if err := writeRunValueAt(path, runValue{}); err != nil {
		t.Fatalf("delete from missing key: %v", err)
	}
	if err := writeRunValueAt(path, runValue{present: true, kind: 1}); err != nil {
		t.Fatalf("write empty REG_SZ: %v", err)
	}
	got, err = readRunValueAt(path)
	if err != nil || got != (runValue{present: true, kind: 1}) {
		t.Fatalf("empty REG_SZ read = %#v, %v", got, err)
	}
	if err := writeRunValueAt(path, runValue{}); err != nil {
		t.Fatalf("delete value: %v", err)
	}
	if err := writeRunValueAt(path, runValue{}); err != nil {
		t.Fatalf("repeat delete: %v", err)
	}
	got, err = readRunValueAt(path)
	if err != nil || got.present {
		t.Fatalf("deleted value read = %#v, %v; want absent", got, err)
	}
}

func TestRegistryRunValueRawRoundTrip(t *testing.T) {
	tests := []struct {
		name string
		v    runValue
	}{
		{"unicode whitespace", stringRunValue(`"C:\程序 文件\WPSProofreading.exe" --install`)},
		{"empty command", stringRunValue("")},
		{"head and tail whitespace", stringRunValue("  command with spaces  ")},
		{"expand string", unicodeRunValue(2, `%TEMP%\程序 文件\tool.exe`)},
		{"binary", runValue{present: true, kind: 3, value: string([]byte{0, 0xff, 0x81, 0, 0x7f})}},
		{"dword", runValue{present: true, kind: 4, value: string([]byte{0x78, 0x56, 0x34, 0x12})}},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			path := registryTestPath(t)
			if err := writeRunValueAt(path, tt.v); err != nil {
				t.Fatalf("write: %v", err)
			}
			got, err := readRunValueAt(path)
			if err != nil || got != tt.v {
				t.Fatalf("round trip = %#v, %v; want %#v", got, err, tt.v)
			}
			if tt.name == "unicode whitespace" {
				gotCommand, err := nativeRegistryString(path)
				if err != nil || gotCommand != `"C:\程序 文件\WPSProofreading.exe" --install` {
					t.Fatalf("native UTF-16 query = %q, %v", gotCommand, err)
				}
			}
		})
	}
}

func TestRegistryRunValueLongBuffer(t *testing.T) {
	path := registryTestPath(t)
	command := `"C:\` + strings.Repeat("长路径 空格\\", 500) + `程序.exe" --install`
	want := stringRunValue(command)
	if len(want.value) <= 256 {
		t.Fatal("test value must exceed initial query buffer")
	}
	if err := writeRunValueAt(path, want); err != nil {
		t.Fatalf("write long value: %v", err)
	}
	got, err := readRunValueAt(path)
	if err != nil || got != want {
		t.Fatalf("long value round trip length=%d, err=%v; want %d bytes", len(got.value), err, len(want.value))
	}
}

func TestRegistryRunValueNoShellOrRegExeEnvironment(t *testing.T) {
	path := registryTestPath(t)
	want := stringRunValue(`"C:\程序 文件\WPSProofreading.exe" --install`)
	t.Setenv("PATH", "")
	t.Setenv("COMSPEC", `Z:\missing\cmd.exe`)
	if err := writeRunValueAt(path, want); err != nil {
		t.Fatalf("write with unusable process environment: %v", err)
	}
	got, err := readRunValueAt(path)
	if err != nil || got != want {
		t.Fatalf("Unicode round trip = %#v, %v; want %#v", got, err, want)
	}
}

// Deny query/set access on a disposable key while retaining an already-open
// WRITE_DAC handle to restore its original DACL even if an assertion fails.
func TestRegistryRunValueAccessDenied(t *testing.T) {
	path := registryTestPath(t)
	if err := writeRunValueAt(path, stringRunValue("initial")); err != nil {
		t.Fatal(err)
	}
	key, err := openRunKey(path, keyReadControl|0x00040000, false) // WRITE_DAC
	if err != nil {
		t.Fatal(err)
	}
	defer syscall.RegCloseKey(key)
	original, err := getRegistrySecurity(key)
	if err != nil {
		t.Fatalf("save test key DACL: %v", err)
	}
	defer func() {
		if err := setRegistrySecurity(key, original); err != nil {
			t.Errorf("restore test key DACL: %v", err)
		}
	}()
	deny, err := securityDescriptorFromSddl(`D:P(D;;0x0003;;;WD)`)
	if err != nil {
		t.Fatalf("create deny DACL: %v", err)
	}
	defer localFree(deny)
	if err := setRegistrySecurityPointer(key, deny); err != nil {
		t.Fatalf("apply deny DACL: %v", err)
	}
	if _, err := readRunValueAt(path); !errors.Is(err, syscall.ERROR_ACCESS_DENIED) {
		t.Fatalf("read under denied KEY_QUERY_VALUE = %v; want access denied", err)
	}
	if err := writeRunValueAt(path, stringRunValue("changed")); !errors.Is(err, syscall.ERROR_ACCESS_DENIED) {
		t.Fatalf("write under denied KEY_SET_VALUE = %v; want access denied", err)
	}
	if err := writeRunValueAt(path, runValue{}); !errors.Is(err, syscall.ERROR_ACCESS_DENIED) {
		t.Fatalf("delete under denied KEY_SET_VALUE = %v; want access denied", err)
	}
}

var (
	regGetKeySecurity = advapi32.NewProc("RegGetKeySecurity")
	regSetKeySecurity = advapi32.NewProc("RegSetKeySecurity")
	convertSDDL       = advapi32.NewProc("ConvertStringSecurityDescriptorToSecurityDescriptorW")
	localFreeProc     = syscall.NewLazyDLL("kernel32.dll").NewProc("LocalFree")
)

func getRegistrySecurity(key syscall.Handle) ([]byte, error) {
	var size uint32
	status, _, _ := regGetKeySecurity.Call(uintptr(key), 4, 0, uintptr(unsafe.Pointer(&size))) // DACL_SECURITY_INFORMATION
	if status != uintptr(syscall.ERROR_INSUFFICIENT_BUFFER) {
		return nil, registryStatus(status)
	}
	data := make([]byte, size)
	status, _, _ = regGetKeySecurity.Call(uintptr(key), 4, uintptr(unsafe.Pointer(&data[0])), uintptr(unsafe.Pointer(&size)))
	if err := registryStatus(status); err != nil {
		return nil, err
	}
	return data[:size], nil
}

func setRegistrySecurity(key syscall.Handle, descriptor []byte) error {
	status, _, _ := regSetKeySecurity.Call(uintptr(key), 4, uintptr(unsafe.Pointer(&descriptor[0])))
	return registryStatus(status)
}

func setRegistrySecurityPointer(key syscall.Handle, descriptor uintptr) error {
	status, _, _ := regSetKeySecurity.Call(uintptr(key), 4, descriptor)
	return registryStatus(status)
}

func securityDescriptorFromSddl(sddl string) (uintptr, error) {
	text, err := syscall.UTF16PtrFromString(sddl)
	if err != nil {
		return 0, err
	}
	var descriptor uintptr
	status, _, lastErr := convertSDDL.Call(uintptr(unsafe.Pointer(text)), 1, uintptr(unsafe.Pointer(&descriptor)), 0)
	if status == 0 {
		if lastErr != nil {
			return 0, lastErr
		}
		return 0, syscall.EINVAL
	}
	return descriptor, nil
}

func localFree(memory uintptr) { _, _, _ = localFreeProc.Call(memory) }

func unicodeRunValue(kind uint32, text string) runValue {
	v := stringRunValue(text)
	v.kind = kind
	return v
}

func nativeRegistryString(path string) (string, error) {
	key, err := openRunKey(path, syscall.KEY_QUERY_VALUE, false)
	if err != nil {
		return "", err
	}
	defer syscall.RegCloseKey(key)
	name := syscall.StringToUTF16Ptr(runValueName)
	data := make([]byte, 2048)
	size := uint32(len(data))
	var kind uint32
	if err := syscall.RegQueryValueEx(key, name, nil, &kind, &data[0], &size); err != nil {
		return "", err
	}
	if kind != 1 || size%2 != 0 {
		return "", fmt.Errorf("unexpected registry type/size: %d/%d", kind, size)
	}
	units := make([]uint16, size/2)
	for i := range units {
		units[i] = binary.LittleEndian.Uint16(data[i*2:])
	}
	return syscall.UTF16ToString(units), nil
}
