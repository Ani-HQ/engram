#!/usr/bin/python3
"""Remove the platform's remaining capabilities before entering tenant code."""
import ctypes
import os
import sys


def restrict() -> None:
    # Linux capability ABI v3 has two 32-bit words per capability set. A process
    # can voluntarily remove its permitted capabilities without CAP_SETPCAP.
    class Header(ctypes.Structure):
        _fields_ = [("version", ctypes.c_uint32), ("pid", ctypes.c_int)]

    class Data(ctypes.Structure):
        _fields_ = [("effective", ctypes.c_uint32), ("permitted", ctypes.c_uint32), ("inheritable", ctypes.c_uint32)]

    libc = ctypes.CDLL(None, use_errno=True)
    libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
    libc.prctl.restype = ctypes.c_int
    libc.capset.argtypes = [ctypes.POINTER(Header), ctypes.POINTER(Data)]
    libc.capset.restype = ctypes.c_int
    if libc.prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS; inherited across exec
        raise RuntimeError()
    header, data = Header(0x20080522, 0), (Data * 2)()
    if libc.capset(ctypes.byref(header), data) != 0:
        raise RuntimeError()
    with open("/proc/self/status", encoding="ascii") as status:
        fields = dict(line.split(":", 1) for line in status if ":" in line)
    for name in ("CapInh", "CapPrm", "CapEff", "CapAmb"):
        if int(fields[name].strip(), 16) != 0:
            raise RuntimeError()
    if fields["NoNewPrivs"].strip() != "1":
        raise RuntimeError()
    # The provider's bounding set cannot be lowered after CAP_SETPCAP has been
    # removed. Zero permitted/inheritable/ambient sets and immutable NNP prevent
    # regaining it. The release preflight verifies the resulting exec chain.


if __name__ == "__main__":
    try:
        if len(sys.argv) < 2 or sys.argv[1] not in ("/usr/local/bin/worker-entrypoint", "/usr/bin/python3"):
            raise RuntimeError()
        restrict()
        os.execve(sys.argv[1], sys.argv[1:], os.environ)
    except Exception:
        sys.stderr.write("Worker privilege restriction failed\n")
        sys.exit(70)
