; 信息流编导工作台 —— 安装脚本（Inno Setup 7）
; 设计原则（对应部署方案两条硬约束）：
;   1. 零决策：不出现目录页、组件页、开始菜单页，只剩一个「安装」按钮
;   2. 纯本地：只装到当前用户目录（免管理员），数据目录在程序目录外侧，卸载不删数据
;
; 版本号由构建脚本通过 /D 传入，不在这里写死。

#ifndef MyAppVersion
  #define MyAppVersion "0.0.0"
#endif
#ifndef MyPayload
  #define MyPayload "C:\payload"
#endif
; 输出目录也由构建脚本用绝对路径传入：Inno 会以 .iss 所在目录解析相对路径
#ifndef MyOutDir
  #define MyOutDir "C:\out"
#endif

#define MyAppName "信息流编导工作台"
#define MyAppPublisher "信息流编导工作台"
#define MyAppURL ""
#define MyDataRoot "{localappdata}\信息流编导工作台"

[Setup]
AppId={{8F2C1A55-6E7A-4C0B-9E3D-5A1B7C9D2E41}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} {#MyAppVersion}
AppPublisher={#MyAppPublisher}
VersionInfoVersion={#MyAppVersion}
DefaultDirName={#MyDataRoot}\app
DefaultGroupName={#MyAppName}
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
DisableWelcomePage=yes
DisableFinishedPage=no
; 每用户安装：不申请管理员权限，公司电脑也能装
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
; 不允许装到自己看不到的地方，也不弹目录选择
UsePreviousAppDir=no
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
Compression=lzma2
SolidCompression=yes
LZMANumBlockThreads=4
OutputDir={#MyOutDir}
OutputBaseFilename=信息流编导工作台-Setup-{#MyAppVersion}
UninstallDisplayName={#MyAppName} {#MyAppVersion}
UninstallDisplayIcon={app}\启动工作台.vbs
SetupIconFile=
WizardStyle=modern
WizardSmallImageFile=
; 升级时先停掉正在跑的工作台，避免文件占用。
; 刻意不用 CloseApplications=yes：它对控制台进程关不掉时会弹「是否现在重启电脑」对话框，
; 让编导做选择题，违背「零决策」原则。改由 [Code] PrepareToInstall 精确处理：
; 按 pids.json 停 → 按可执行路径兜底清杀 → 等引擎 DLL 释放，全程无弹窗。
CloseApplications=no

[Languages]
Name: "chinesesimp"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Messages]
chinesesimp.SetupAppTitle=安装 {#MyAppName}
chinesesimp.SetupWindowTitle=安装 {#MyAppName}
chinesesimp.FinishedHeadingLabel=安装完成
chinesesimp.FinishedLabelNoIcons=信息流编导工作台已安装完成。\r\n\r\n桌面上有「信息流编导工作台」图标，双击即可打开。\r\n初始账号写在「数据目录\初始账号.txt」里。
chinesesimp.ButtonInstall=安装
chinesesimp.ButtonFinish=完成

[Files]
; 运行时二进制（node.exe / esbuild.exe）从主清单里排除。
; 注意 Excludes 的匹配规则是实测出来的：只按「文件名」匹配、逗号分隔；
; 写成相对路径 / 绝对路径 / 分号分隔都无效（会静默不排除）。
; 包里只有 runtime\node\node.exe 与 @esbuild\win32-x64\esbuild.exe 两个同名文件，不会被误伤。
Source: "{#MyPayload}\*"; DestDir: "{app}"; Excludes: "node.exe,esbuild.exe"; Flags: ignoreversion recursesubdirs createallsubdirs
; 这两个二进制改为单独安装，带 onlyifdoesntexist：目标已存在就原样跳过，绝不走「删除后替换」。
; 原因（2026-09-23 实测）：升级时 Inno 会「先删旧文件再写新文件」，而部分机器的安全策略
; 禁止删除 exe（与被占用无关，重命名却可以），结果报「DeleteFile 失败；错误代码 5」、
; 整个安装回滚。跳过替换则彻底绕开这个坑：升级沿用已装好的运行时，功能不受影响。
Source: "{#MyPayload}\runtime\node\node.exe"; DestDir: "{app}\runtime\node"; Flags: ignoreversion onlyifdoesntexist
Source: "{#MyPayload}\node_modules\@esbuild\win32-x64\esbuild.exe"; DestDir: "{app}\node_modules\@esbuild\win32-x64"; Flags: ignoreversion onlyifdoesntexist
; 另以 dontcopy 收进包：升级时 [Code] 用哈希比对判断确有更新后，再「原地覆盖」（不删除）。
Source: "{#MyPayload}\runtime\node\node.exe"; DestDir: "{tmp}"; Flags: dontcopy
Source: "{#MyPayload}\node_modules\@esbuild\win32-x64\esbuild.exe"; DestDir: "{tmp}"; Flags: dontcopy
; kill-nodes.ps1 同理：升级老版本时 {app} 里还没有它，必须从包自身解出兜底清杀脚本。
Source: "{#MyPayload}\kill-nodes.ps1"; DestDir: "{tmp}"; Flags: dontcopy
; 备份脚本同理：从 1.1.5 及更早版本升级时 {app} 里没有 backup.js，
; 而「升级前自动备份」正是最不能缺席的一次备份，必须从包自身解出执行。
Source: "{#MyPayload}\backup.js"; DestDir: "{tmp}"; Flags: dontcopy

; 快捷方式不再用 [Icons] 段，改由下方 [Code] 代码创建，原因有二：
;   1. v1.1.0 曾把桌面图标写到 {commondesktop}（C:\Users\Public\Desktop），
;      该目录对普通登录用户只有读权限，免管理员安装写 .lnk 被拒，
;      报「IPersistFile::Save 失败；错误代码 0x80070005 拒绝访问」→ 必须用 {userdesktop}。
;   2. [Icons] 里任何一条创建失败都会以致命错误中断整个安装；
;      代码创建则只记录并在最后提示，安装照常完成（编导机器上可能有安全软件拦 .lnk）。

[Run]
; 安装后自动生成配置与账号（隐藏执行），再拉起工作台并打开浏览器
Filename: "{app}\runtime\node\node.exe"; Parameters: """{app}\init-env.js"""; Flags: runhidden waituntilterminated
Filename: "wscript.exe"; Parameters: """{app}\启动工作台.vbs"""; Description: "立即打开工作台"; Flags: postinstall nowait skipifsilent

[UninstallRun]
; 卸载前先停工作台：pids.json 精确关 + 按路径兜底清杀（孤儿实例），都不弹窗
Filename: "{app}\runtime\node\node.exe"; Parameters: """{app}\stop.js"""; RunOnceId: "StopWorkbench"; Flags: runhidden
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\kill-nodes.ps1"""; RunOnceId: "KillOrphanNode"; Flags: runhidden

[UninstallDelete]
; 只删程序目录（Inno 默认行为）；数据目录在 {localappdata}\信息流编导工作台\data，
; 不在 {app} 内，因此卸载与升级都不会碰到编导的任务、资料包和成片。
Type: files; Name: "{app}\.env"
; 被 onlyifdoesntexist 跳过的运行时二进制不会进卸载清单，这里补删，避免卸载后残留
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\node_modules\@esbuild"

[Code]
var
  FailedLinks: TStringList;

// 等某个引擎 DLL 释放：存在则每秒尝试删除一次（删除成功也无妨，随后写入新版），最多 60 秒。
// 实测（2026-09-23）：进程被强制结束后的短时间内，本机安全软件可能仍扣住映像文件，
// 10 秒等待不够；60 秒能扛过扣留期。
function DllReleased(const P: String): Boolean;
var
  I: Integer;
begin
  Result := True;
  if FileExists(P) = False then
    Exit;
  for I := 1 to 60 do
  begin
    if DeleteFile(P) then
      Exit;
    Sleep(1000);
  end;
  Result := False;
end;

// 升级旗标路径：插旗期间 launcher 拒绝启动（防止清杀后又被双击拉起、重新锁住文件）
function UpgradeFlagPath(): String;
begin
  Result := ExpandConstant('{localappdata}') + '\信息流编导工作台\data\upgrade.lock';
end;

function LockAbortMsg(): String;
begin
  Result := '工作台正在运行，且未能自动停止。' + #13#10 +
    '请先点桌面或开始菜单的「停止工作台」，稍后再运行本安装程序。';
end;

// 更新运行时二进制（node.exe / esbuild.exe）：只「原地覆盖」，绝不删除。
// [Files] 里这两个文件带 onlyifdoesntexist，升级时会被跳过，所以这里负责「确有更新」的场景：
//   哈希一致 → 什么都不做；哈希不同 → 备份 → 覆盖 → 校验 → 校验不过就回滚备份。
// 任何一步失败都只往 installer-prep.log 记一行，绝不中断安装：编导机器上保留旧版运行时
// 远比装出一个半成品强。
procedure RefreshRuntimeBinary(const TempName, DestPath: String);
var
  Src, Bak, Mark: String;
begin
  Mark := ExpandConstant('{localappdata}') + '\信息流编导工作台\data\installer-prep.log';
  Src := ExpandConstant('{tmp}') + '\' + TempName;
  Bak := DestPath + '.bak';
  if FileExists(Src) = False then
    Exit;
  if FileExists(DestPath) = False then
  begin
    // 目标不存在（旧版被安全软件清掉等）：直接放一份，保证 [Run] 能唤起
    ForceDirectories(ExtractFileDir(DestPath));
    if CopyFile(Src, DestPath, False) then
      SaveStringToFile(Mark, 'runtime placed: ' + DestPath + #13#10, True)
    else
      SaveStringToFile(Mark, 'runtime MISSING: ' + DestPath + #13#10, True);
    Exit;
  end;
  if GetSHA256OfFile(Src) = GetSHA256OfFile(DestPath) then
    Exit; // 版本一致，跳过
  DeleteFile(Bak);
  CopyFile(DestPath, Bak, False);
  if CopyFile(Src, DestPath, False) = False then
  begin
    DeleteFile(Bak);
    SaveStringToFile(Mark, 'runtime keep-old(locked): ' + DestPath + #13#10, True);
    Exit;
  end;
  if GetSHA256OfFile(Src) = GetSHA256OfFile(DestPath) then
  begin
    DeleteFile(Bak);
    SaveStringToFile(Mark, 'runtime updated: ' + DestPath + #13#10, True);
  end
  else
  begin
    CopyFile(Bak, DestPath, False);
    DeleteFile(Bak);
    SaveStringToFile(Mark, 'runtime rolled-back: ' + DestPath + #13#10, True);
  end;
end;

// 升级场景：工作台可能正在运行。运行中的 node 会映射 Prisma 引擎 DLL，
// 直接替换会报「DeleteFile 失败；错误代码 5」。处理顺序：
//   插升级旗标（launcher 见旗标拒启，免得清杀后又被双击拉起）→ stop.js 按 pids.json 精确关 →
//   kill-nodes.ps1 按可执行路径兜底清杀（孤儿实例）→ 等引擎 DLL 释放（最长 60 秒）→
//   运行时二进制原地覆盖 → 仍锁住则给出明确指引并中止，避免装成半吊子。
// 注意：node.exe / esbuild.exe **不在这里等释放**——本机实测「删除 exe」会被安全策略拦截
// （与占用无关），把它们放进等待清单只会白白失败；它们改由 RefreshRuntimeBinary 覆盖更新。
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  NodeExe, StopJs, Ps1: String;
  Code, CodePs, CodeBk: Integer;
  OkStop, OkPs, OkBk: Boolean;
begin
  Result := '';
  NodeExe := ExpandConstant('{app}') + '\runtime\node\node.exe';
  StopJs := ExpandConstant('{app}') + '\stop.js';
  Ps1 := ExpandConstant('{app}') + '\kill-nodes.ps1';
  if (FileExists(NodeExe) = False) or (FileExists(StopJs) = False) then
    Exit; // 首次安装没有可停的东西
  SaveStringToFile(UpgradeFlagPath(), '1', False);
  Exec(NodeExe, '"' + StopJs + '"', ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Code);
  OkStop := (Code = 0);
  // 兜底清杀脚本与运行时二进制都必须从安装包自身解出：升级老版本时 {app} 里还没有它们
  ExtractTemporaryFile('kill-nodes.ps1');
  ExtractTemporaryFile('node.exe');
  ExtractTemporaryFile('esbuild.exe');
  Ps1 := ExpandConstant('{tmp}') + '\kill-nodes.ps1';
  OkPs := Exec('powershell.exe', '-NoProfile -ExecutionPolicy Bypass -File "' + Ps1 + '"',
    ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, CodePs);
  // 升级前自动备份：此刻进程刚被清干净，复制出来的数据库不会是「写到一半」的半截状态。
  // 备份失败**不拦安装**——装不上比少一份备份更糟，但必须留下痕迹好事后补救。
  ExtractTemporaryFile('backup.js');
  OkBk := Exec(ExpandConstant('{tmp}') + '\node.exe',
    '"' + ExpandConstant('{tmp}') + '\backup.js" --tag=pre-upgrade',
    ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, CodeBk);
  // 诊断痕迹：写到数据目录（Inno 的 {tmp} 会随安装结束销毁，不能落那里）
  SaveStringToFile(ExpandConstant('{localappdata}') + '\信息流编导工作台\data\installer-prep.log',
    'stop.js execOk=' + IntToStr(Ord(OkStop)) + ' code=' + IntToStr(Code) + #13#10 +
    'ps1 execOk=' + IntToStr(Ord(OkPs)) + ' code=' + IntToStr(CodePs) + #13#10 +
    'backup execOk=' + IntToStr(Ord(OkBk)) + ' code=' + IntToStr(CodeBk) + #13#10, False);
  if DllReleased(ExpandConstant('{app}') + '\node_modules\.prisma\client\query_engine-windows.dll.node') = False then begin Result := LockAbortMsg(); Exit; end;
  if DllReleased(ExpandConstant('{app}') + '\node_modules\prisma\client\query_engine-windows.dll.node') = False then begin Result := LockAbortMsg(); Exit; end;
  // 运行时二进制：不删除，只在确有版本变化时原地覆盖（失败也只是沿用旧版）
  RefreshRuntimeBinary('node.exe', NodeExe);
  RefreshRuntimeBinary('esbuild.exe', ExpandConstant('{app}') + '\node_modules\@esbuild\win32-x64\esbuild.exe');
end;

procedure DeinitializeSetup();
begin
  // 无论装完还是中止，都摘掉升级旗标（文件不存在时删除是无害的）
  DeleteFile(UpgradeFlagPath());
end;

// 创建单个快捷方式；失败只记录不抛出（CreateShellLink 失败时可能抛异常，也可能返回错误描述，两种都接住）
procedure CreateLinkOrSkip(const LinkPath, Comment, Target, Params, WorkDir, IconFile: String);
var
  Err: String;
begin
  try
    Err := CreateShellLink(LinkPath, Comment, Target, Params, WorkDir, IconFile, 0, SW_SHOWNORMAL);
    if Err <> '' then
      FailedLinks.Add(LinkPath + '（' + Err + '）');
  except
    // Inno 的 PascalScript 不支持 on E: Exception do，用 GetExceptionMessage 取错误
    FailedLinks.Add(LinkPath + '（' + GetExceptionMessage + '）');
  end;
end;

function InitializeSetup(): Boolean;
begin
  FailedLinks := TStringList.Create;
  Result := True;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  GroupDir: String;
begin
  if CurStep <> ssPostInstall then
    Exit;
  // 开始菜单组（当前用户，免管理员可写）
  GroupDir := ExpandConstant('{userprograms}') + '\' + '{#MyAppName}';
  ForceDirectories(GroupDir);
  CreateLinkOrSkip(GroupDir + '\信息流编导工作台.lnk', '启动信息流编导工作台',
    'wscript.exe', '"' + ExpandConstant('{app}') + '\启动工作台.vbs"',
    ExpandConstant('{app}'), ExpandConstant('{app}') + '\runtime\node\node.exe');
  CreateLinkOrSkip(GroupDir + '\停止工作台.lnk', '停止信息流编导工作台',
    'wscript.exe', '"' + ExpandConstant('{app}') + '\停止工作台.vbs"',
    ExpandConstant('{app}'), '');
  // 桌面图标（当前用户桌面，免管理员安装下可写）
  CreateLinkOrSkip(ExpandConstant('{userdesktop}') + '\信息流编导工作台.lnk', '启动信息流编导工作台',
    'wscript.exe', '"' + ExpandConstant('{app}') + '\启动工作台.vbs"',
    ExpandConstant('{app}'), ExpandConstant('{app}') + '\runtime\node\node.exe');
  if FailedLinks.Count > 0 then
    SuppressibleMsgBox(
      '以下快捷方式未能创建（多是被安全软件拦截，不影响程序本身使用）：' + #13#10 + #13#10 +
      FailedLinks.Text + #13#10 +
      '可以从开始菜单的「信息流编导工作台」启动，或打开程序目录双击「启动工作台」。',
      mbError, MB_OK, IDOK);
end;

// [Icons] 段没有了，卸载时需自己删掉上面创建的快捷方式
// 卸载：先备份数据，再清掉快捷方式。
// 卸载本身不碰数据目录（它在 {localappdata} 外侧），但编导往往是在卸载之后
// 才发现「有份资料还要用」，届时没备份就再也拿不回来。失败只记日志，绝不拦住卸载。
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  NodeExe, StopJs, BkJs: String;
  Code: Integer;
begin
  if CurUninstallStep <> usUninstall then
    Exit;
  NodeExe := ExpandConstant('{app}') + '\runtime\node\node.exe';
  StopJs := ExpandConstant('{app}') + '\stop.js';
  BkJs := ExpandConstant('{app}') + '\backup.js';
  if (FileExists(NodeExe)) and (FileExists(BkJs)) then
  begin
    // 先停进程：占用中的数据库复制出来可能是半截的
    if FileExists(StopJs) then
      Exec(NodeExe, '"' + StopJs + '"', ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Code);
    Exec(NodeExe, '"' + BkJs + '" --tag=pre-uninstall',
      ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Code);
  end;
  DeleteFile(ExpandConstant('{userdesktop}') + '\信息流编导工作台.lnk');
  DelTree(ExpandConstant('{userprograms}') + '\' + '{#MyAppName}', True, True, True);
end;
