' 停止工作台（关闭网页服务与后台处理程序）
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = here
sh.Run """" & here & "\runtime\node\node.exe"" """ & here & "\stop.js""", 0, True
MsgBox "工作台已停止。", 64, "信息流编导工作台"
