"""Attempts to modify the input file, which is mounted read-only. A real
cleaning script should never be able to mutate the raw upload it was
given — this proves that boundary is enforced by the mount, not just by
convention/trust in the generated code."""
try:
    with open("/work/input/data.csv", "a") as f:
        f.write("tampered,row\n")
    print("WROTE TO READ-ONLY INPUT — sandbox isolation FAILED")
except OSError as e:
    print(f"Write to read-only input blocked as expected: {e}")
