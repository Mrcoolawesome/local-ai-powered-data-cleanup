"""Malicious/buggy-script stand-in: attempts an outbound network call, which
--network none should make impossible. If this ever prints "REACHED
NETWORK", the sandbox's isolation is broken and that's a critical finding,
not a pass."""
import socket

try:
    socket.create_connection(("8.8.8.8", 53), timeout=5)
    print("REACHED NETWORK — sandbox isolation FAILED")
except OSError as e:
    print(f"Network call blocked as expected: {e}")
