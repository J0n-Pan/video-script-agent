' 启动工作台（隐藏运行，不弹黑窗口）
' 由安装程序创建快捷方式指向本文件；编导双击即可。
Set fso = CreateObject("Scripting.FileSystemObject")
here = fso.GetParentFolderName(WScript.ScriptFullName)
Set sh = CreateObject("WScript.Shell")
node = here & "\runtime\node\node.exe"
launcher = here & "\launcher.js"
If Not fso.FileExists(node) Then
  MsgBox "未找到运行组件，请重新安装工作台。", 16, "信息流编导工作台"
  WScript.Quit 1
End If
sh.CurrentDirectory = here
' 首次启动会自动打开浏览器；重复双击不会再起一套进程，只是把已运行的页面打开
sh.Run """" & node & """ """ & launcher & """", 0, False
