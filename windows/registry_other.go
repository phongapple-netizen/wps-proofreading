//go:build !windows

package main

import "errors"

func readRunValue() (runValue, error) {
	return runValue{}, errors.New("自启动注册表仅支持 Windows")
}

func writeRunValue(runValue) error {
	return errors.New("自启动注册表仅支持 Windows")
}
