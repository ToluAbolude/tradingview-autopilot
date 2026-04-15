Dim port
port = "9222"
If WScript.Arguments.Count > 0 Then port = WScript.Arguments(0)

Set oShell = CreateObject("WScript.Shell")
Set oEnv = oShell.Environment("Process")
oEnv("ELECTRON_EXTRA_LAUNCH_ARGS") = "--remote-debugging-port=" & port
oShell.Run "explorer.exe shell:AppsFolder\TradingView.Desktop_n534cwy3pjxzj!TradingView.Desktop", 1, False
WScript.Sleep 1000
WScript.Echo "Launched with --remote-debugging-port=" & port
