"""Runaway-script stand-in: never terminates on its own. Proves the
host-side `timeout` wrapper in run-sandboxed.sh actually kills the
container rather than the sandbox hanging forever on a buggy or
adversarial generated script."""
while True:
    pass
