' ============================================================================
'  TradingMCP - TradingView Silent Startup Launcher
'  Launches TradingView Desktop with CDP on port 9222 at Windows login.
'  Runs silently (no window shown).
'
'  Supports both install types:
'    - Traditional (.exe in LocalAppData / Program Files)
'    - Microsoft Store (MSIX package)
'
'  Skips launch if TradingView is already running with CDP active.
' ============================================================================

Dim port, oShell, oFSO, oHTTP, cdpOk

port  = "9222"
Set oShell = CreateObject("WScript.Shell")
Set oFSO   = CreateObject("Scripting.FileSystemObject")

' --- Check if CDP is already responding (TV already running with CDP) --------
cdpOk = False
On Error Resume Next
Set oHTTP = CreateObject("MSXML2.XMLHTTP")
oHTTP.Open "GET", "http://localhost:" & port & "/json/version", False
oHTTP.Send
If oHTTP.Status = 200 Then cdpOk = True
On Error GoTo 0

If cdpOk Then
    ' TradingView already running with CDP - nothing to do
    WScript.Quit 0
End If

' --- Short delay so desktop is ready before launching ------------------------
WScript.Sleep 5000

' --- Try traditional install paths first -------------------------------------
Dim tvPaths(3), tvExe, i
tvPaths(0) = oShell.ExpandEnvironmentStrings("%LOCALAPPDATA%\TradingView\TradingView.exe")
tvPaths(1) = oShell.ExpandEnvironmentStrings("%PROGRAMFILES%\TradingView\TradingView.exe")
tvPaths(2) = oShell.ExpandEnvironmentStrings("%PROGRAMFILES(X86)%\TradingView\TradingView.exe")
tvExe = ""

For i = 0 To 2
    If oFSO.FileExists(tvPaths(i)) Then
        tvExe = tvPaths(i)
        Exit For
    End If
Next

If tvExe <> "" Then
    ' Traditional install - launch directly with CDP flag
    oShell.Run """" & tvExe & """ --remote-debugging-port=" & port, 0, False
    WScript.Quit 0
End If

' --- Fall back to Microsoft Store (MSIX) install ----------------------------
Dim oEnv
Set oEnv = oShell.Environment("Process")
oEnv("ELECTRON_EXTRA_LAUNCH_ARGS") = "--remote-debugging-port=" & port
oShell.Run "explorer.exe shell:AppsFolder\TradingView.Desktop_n534cwy3pjxzj!TradingView.Desktop", 0, False

WScript.Quit 0
