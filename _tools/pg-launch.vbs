Option Explicit
Dim sh, postgres, dataDir, port, logFile, cmd
Set sh = CreateObject("WScript.Shell")
postgres = WScript.Arguments(0)
dataDir = WScript.Arguments(1)
port = WScript.Arguments(2)
logFile = WScript.Arguments(3)
cmd = "cmd /c """"" & postgres & """ -D """ & dataDir & """ -p " & port & " >> """ & logFile & """ 2>&1"""
sh.Run cmd, 0, False
