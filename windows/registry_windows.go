//go:build windows

package main

import (
	"errors"
	"fmt"
	"syscall"
	"unsafe"
)

var (
	advapi32       = syscall.NewLazyDLL("advapi32.dll")
	regCreateKeyEx = advapi32.NewProc("RegCreateKeyExW")
	regSetValueEx  = advapi32.NewProc("RegSetValueExW")
	regDeleteValue = advapi32.NewProc("RegDeleteValueW")
)

func readRunValue() (runValue, error)    { return readRunValueAt(runKeyPath) }
func writeRunValue(value runValue) error { return writeRunValueAt(runKeyPath, value) }

// Registry APIs return a Win32 status directly; GetLastError (the third
// Proc.Call result) is not their error code. Only FILE_NOT_FOUND is absence.
func registryStatus(status uintptr) error {
	if status == 0 {
		return nil
	}
	return syscall.Errno(status)
}

func openRunKey(path string, access uint32, create bool) (syscall.Handle, error) {
	name, err := syscall.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	var key syscall.Handle
	if create {
		status, _, _ := regCreateKeyEx.Call(syscall.HKEY_CURRENT_USER,
			uintptr(unsafe.Pointer(name)), 0, 0, 0, uintptr(access), 0,
			uintptr(unsafe.Pointer(&key)), 0)
		err = registryStatus(status)
	} else {
		err = syscall.RegOpenKeyEx(syscall.HKEY_CURRENT_USER, name, 0, access, &key)
	}
	return key, err
}

func readRunValueAt(path string) (runValue, error) {
	key, err := openRunKey(path, syscall.KEY_QUERY_VALUE, false)
	if errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) {
		return runValue{}, nil
	}
	if err != nil {
		return runValue{}, fmt.Errorf("无法读取现有自启动项（打开注册表键）: %w", err)
	}
	defer syscall.RegCloseKey(key)
	name := syscall.StringToUTF16Ptr(runValueName)
	data := make([]byte, 256)
	for {
		size := uint32(len(data))
		var kind uint32
		err = syscall.RegQueryValueEx(key, name, nil, &kind, &data[0], &size)
		if errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) {
			return runValue{}, nil
		}
		if errors.Is(err, syscall.ERROR_MORE_DATA) && size > uint32(len(data)) {
			data = make([]byte, size)
			continue
		}
		if err != nil {
			return runValue{}, fmt.Errorf("无法读取现有自启动项（查询注册表值）: %w", err)
		}
		return runValue{present: true, kind: kind, value: string(data[:size])}, nil
	}
}

func writeRunValueAt(path string, value runValue) error {
	key, err := openRunKey(path, syscall.KEY_SET_VALUE, value.present)
	if !value.present && errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("无法更新自启动项（打开注册表键）: %w", err)
	}
	defer syscall.RegCloseKey(key)
	name := syscall.StringToUTF16Ptr(runValueName)
	if !value.present {
		status, _, _ := regDeleteValue.Call(uintptr(key), uintptr(unsafe.Pointer(name)))
		err = registryStatus(status)
		if errors.Is(err, syscall.ERROR_FILE_NOT_FOUND) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("无法删除 WPSProofreading 自启动项: %w", err)
		}
		return nil
	}
	data := []byte(value.value)
	var ptr *byte
	if len(data) > 0 {
		ptr = &data[0]
	}
	status, _, _ := regSetValueEx.Call(uintptr(key), uintptr(unsafe.Pointer(name)),
		0, uintptr(value.kind), uintptr(unsafe.Pointer(ptr)), uintptr(len(data)))
	if err = registryStatus(status); err != nil {
		return fmt.Errorf("无法写入 WPSProofreading 自启动项: %w", err)
	}
	return nil
}
