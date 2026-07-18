// spawn-clean.c — PROBE (Phase 1)
//
// Launch a command with the parent app's (Chrome's) *responsibility* shed, so the
// spawned child becomes its own responsible process. Chrome's LSFileQuarantineEnabled
// is keyed to the responsible app; once a descendant is no longer attributed to
// Chrome, files it (and its descendants, e.g. `go build` outputs) create should NOT
// get com.apple.quarantine and therefore not be blocked by Gatekeeper.
//
// Lever: responsibility_spawnattrs_setdisclaim (private; used by iTerm2/LLDB/QtCreator,
// and ghostty#9263 as a "launch helper to shed the responsible-process bit").
// Resolved via dlsym so the build never fails if the symbol is absent.
//
// NOTE: libquarantine qtn_proc_apply_to_self was tried and REJECTED — it ENABLES
// quarantining of created files (that is what browsers use to add it), even with
// flags=0 (produces `com.apple.quarantine: ...;;`). It is the wrong direction.
//
// Usage:   spawn-clean <program> [args...]
// Compile: clang -o spawn-clean spawn-clean.c

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <unistd.h>
#include <spawn.h>
#include <dlfcn.h>
#include <sys/wait.h>

extern char **environ;

int main(int argc, char **argv) {
  if (argc < 2) { fprintf(stderr, "usage: spawn-clean <program> [args...]\n"); return 2; }

  posix_spawnattr_t attr;
  posix_spawnattr_init(&attr);

  int disclaim_ok = 0;
  int (*p_disclaim)(posix_spawnattr_t *, int) =
      (int (*)(posix_spawnattr_t *, int))dlsym(RTLD_DEFAULT, "responsibility_spawnattrs_setdisclaim");
  if (p_disclaim) disclaim_ok = (p_disclaim(&attr, 1) == 0);

  fprintf(stderr, "[spawn-clean] disclaim=%s\n", disclaim_ok ? "ok" : "unavailable");

  // No file actions → the child inherits our stdin/stdout/stderr unchanged, so the
  // native host's streaming pipes pass straight through.
  pid_t pid;
  int rc = posix_spawnp(&pid, argv[1], NULL, &attr, &argv[1], environ);
  posix_spawnattr_destroy(&attr);
  if (rc != 0) { fprintf(stderr, "[spawn-clean] spawn failed: %s\n", strerror(rc)); return 127; }

  int status = 0;
  while (waitpid(pid, &status, 0) < 0) {
    if (errno != EINTR) { perror("[spawn-clean] waitpid"); return 1; }
  }
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) return 128 + WTERMSIG(status);
  return 1;
}
