# 关闭所有从工作台程序目录启动的 node 进程（按可执行文件路径精确匹配，不碰电脑上其它 Node 程序）。
# 供安装程序在升级/卸载前调用：pids.json 可能缺失或过期（孤儿实例），按路径清杀才彻底。
# 执行痕迹写入 %TEMP%\kill-nodes.log 便于诊断（找到几个、杀了几个）。
$app = Join-Path $env:LOCALAPPDATA '信息流编导工作台\app'
$log = Join-Path $env:TEMP 'kill-nodes.log'
$found = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($app, [System.StringComparison]::OrdinalIgnoreCase) })
"$(Get-Date -Format s) found=$($found.Count)" | Out-File -FilePath $log -Append -Encoding utf8
$found | ForEach-Object {
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  "killed=$($_.ProcessId) path=$($_.ExecutablePath)" | Out-File -FilePath $log -Append -Encoding utf8
}
