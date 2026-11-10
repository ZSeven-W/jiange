// Command jiange is a tiny Uppcoder boot shim. The platform's default Go
// start (undocumented; likely `go run .` or `go build .` in the repo root)
// compiles and runs this package, which execs run.sh and the prebuilt
// server binary at bin/jiange. The real server lives in the nested
// server/ module and is not imported here.
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

func logf(format string, args ...any) {
	fmt.Fprintf(os.Stdout, format+"\n", args...)
}

func hold() {
	logf("holding the process so the container stays up")
	for {
		time.Sleep(time.Hour)
	}
}

func findRoot() (string, error) {
	var candidates []string
	if wd, err := os.Getwd(); err == nil {
		candidates = append(candidates, wd)
	}
	if exe, err := os.Executable(); err == nil {
		if resolved, err := filepath.EvalSymlinks(exe); err == nil {
			candidates = append(candidates, filepath.Dir(resolved))
		} else {
			candidates = append(candidates, filepath.Dir(exe))
		}
	}
	for _, dir := range candidates {
		if st, err := os.Stat(filepath.Join(dir, "run.sh")); err == nil && !st.IsDir() {
			return dir, nil
		}
	}
	return "", fmt.Errorf("run.sh not found in cwd or next to the executable")
}

func main() {
	root, err := findRoot()
	if err != nil {
		logf("boot shim: %v", err)
		hold()
	}
	run := filepath.Join(root, "run.sh")
	if err := os.Chdir(root); err != nil {
		logf("boot shim: chdir %s: %v", root, err)
		hold()
	}
	logf("boot shim: exec %s", run)
	if err := syscall.Exec(run, []string{run}, os.Environ()); err != nil {
		logf("boot shim: exec %s: %v", run, err)
		hold()
	}
}
