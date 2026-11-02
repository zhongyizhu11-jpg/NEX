package main

import (
	"bytes"
	"os"
	"path/filepath"
	"time"
)

/*
Agent 在 agentStateDir（/var/lib/forwardx-agent）下记着端口归属哪条规则、转发类型、目标、隧道、
托管服务签名这些小状态文件，重启后靠它们清理和对账。原来是 os.WriteFile 加 `_ =`：磁盘满或只读时
写不进去也没人知道，重启后按错的状态去清理，表现为规则错乱，很难查。

writeStateFile 统一做：建目录、内容没变就不写（心跳里每轮都会重写一遍运行中的规则）、
原子替换（临时文件 + fsync + rename + 目录 fsync，见 writeFileAtomicDurable）、失败写日志。
*/

const stateFileWriteLogInterval = 5 * time.Minute

// agentStatePath 返回状态目录下的文件路径。
func agentStatePath(name string) string {
	return filepath.Join(agentStateDir, name)
}

func writeStateFile(path string, data []byte) error {
	if existing, err := os.ReadFile(path); err == nil && bytes.Equal(existing, data) {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
		logStateFileWriteError(path, err)
		return err
	}
	if err := writeFileAtomicDurable(path, data, 0644); err != nil {
		logStateFileWriteError(path, err)
		return err
	}
	return nil
}

func logStateFileWriteError(path string, err error) {
	if shouldLogAgentReport("state-file-write:"+path, stateFileWriteLogInterval) {
		logf("state file write failed path=%s: %v", path, err)
	}
}
