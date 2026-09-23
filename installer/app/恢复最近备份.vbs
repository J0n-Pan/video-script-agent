' 从最近的备份恢复工作台数据（用于误删、升级出错等场景）
' 过程：先停止工作台 → 把当前数据另存为「回滚前-…」→ 覆盖式写回备份内容
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = here
node = """" & here & "\runtime\node\node.exe"""

' 先列一下有哪些备份，让编导知道要恢复到哪一点
Set ex = sh.Exec(node & " """ & here & "\restore.js"" --list")
list = ex.StdOut.ReadAll()
If InStr(list, "还没有任何备份") > 0 Or InStr(list, "没有可恢复的备份") > 0 Then
  MsgBox "还没有任何备份，无法恢复。", 48, "信息流编导工作台"
  WScript.Quit
End If

ans = MsgBox("即将把工作台数据恢复到最近一次备份。" & vbCrLf & vbCrLf & _
  "当前数据会先被另存一份（名为「回滚前-…」），万一恢复错了还能退回来。" & vbCrLf & vbCrLf & _
  "可用备份（最新在最上面）：" & vbCrLf & list & vbCrLf & _
  "确定要继续吗？", 33, "信息流编导工作台")
If ans <> 1 Then WScript.Quit

' 停止工作台：数据文件被占用时恢复会失败或被写坏。
' stop.js 自己就把「记录里的 PID + 孤儿实例（按端口兜底）+ 强杀」都做完了，
' 过去这里还要再补一条 powershell -ExecutionPolicy Bypass 调 kill-nodes.ps1，已删（安全软件误报源）。
sh.Run node & " """ & here & "\stop.js""", 0, True

Set ex2 = sh.Exec(node & " """ & here & "\restore.js""")
out = ex2.StdOut.ReadAll()
MsgBox out, 64, "信息流编导工作台"
