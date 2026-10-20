Set WshShell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

userProfile = WshShell.ExpandEnvironmentStrings("%USERPROFILE%")
logDir = userProfile & "\.chums\logs"
If Not fso.FolderExists(logDir) Then
    fso.CreateFolder(logDir)
End If

chumsDir = "C:\Users\veks9\Github-Repos\chums"
WshShell.CurrentDirectory = chumsDir

' 1. Start Hub silently (0 = hidden window)
hubCmd = "cmd /c node hub/hub.mjs >> """ & logDir & "\hub.log"" 2>&1"
WshShell.Run hubCmd, 0, False

' 2. Pause 2 seconds for Hub HTTP ports (7717/7718) to bind
WScript.Sleep 2000

' 3. Start Agent Bridge silently (0 = hidden window)
bridgeCmd = "cmd /c node --experimental-websocket tools/chums-agent-bridge.mjs >> """ & logDir & "\bridge.log"" 2>&1"
WshShell.Run bridgeCmd, 0, False
