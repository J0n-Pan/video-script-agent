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
; 卸载入口不再是自带 exe：1.2.0 那个自研「卸载.exe」因为内含「写脚本到临时目录 + 隐藏执行 +
; 递归删目录 + 自删」的行为链，被 Defender 判为 Program:Script/Wacapew.A!ml 并当场隔离，
; 等于功能直接消失。1.2.1 起改用 Inno 官方卸载器（unins000.exe，海量正常软件都在用），
; 在 {app} 与开始菜单放一个中文名「卸载.lnk」指向它，编导双击体验不变。
; 这两个二进制改为单独安装，带 onlyifdoesntexist：目标已存在就原样跳过，绝不走「删除后替换」。
; 原因（2026-09-23 实测）：升级时 Inno 会「先删旧文件再写新文件」，而部分机器的安全策略
; 禁止删除 exe（与被占用无关，重命名却可以），结果报「DeleteFile 失败；错误代码 5」、
; 整个安装回滚。跳过替换则彻底绕开这个坑：升级沿用已装好的运行时，功能不受影响。
Source: "{#MyPayload}\runtime\node\node.exe"; DestDir: "{app}\runtime\node"; Flags: ignoreversion onlyifdoesntexist
Source: "{#MyPayload}\node_modules\@esbuild\win32-x64\esbuild.exe"; DestDir: "{app}\node_modules\@esbuild\win32-x64"; Flags: ignoreversion onlyifdoesntexist
; 另以 dontcopy 收进包：升级时 [Code] 用哈希比对判断确有更新后，再「原地覆盖」（不删除）。
Source: "{#MyPayload}\runtime\node\node.exe"; DestDir: "{tmp}"; Flags: dontcopy
Source: "{#MyPayload}\node_modules\@esbuild\win32-x64\esbuild.exe"; DestDir: "{tmp}"; Flags: dontcopy
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

; 卸载前先停工作台：停进程这件事**统一由 [Code] 的 CurUninstallStepChanged(usUninstall) 做**
; （见下方），不再放 [UninstallRun]，原因有二：
;   ① 停 + 备份 + 清快捷方式必须在同一处按确定顺序发生，分两个钩子容易踩「谁先跑」的坑；
;   ② 过去的兜底清杀要 `powershell -ExecutionPolicy Bypass -File kill-nodes.ps1`，
;      是安全软件的典型启发式特征，1.2.1 起改为 stop.js 内部用系统自带 taskkill /T 完成。

[UninstallDelete]
; 只删程序目录（Inno 默认行为）；数据目录在 {localappdata}\信息流编导工作台\data，
; 不在 {app} 内，因此卸载与升级都不会碰到编导的任务、资料包和成片。
Type: files; Name: "{app}\.env"
; 被 onlyifdoesntexist 跳过的运行时二进制不会进卸载清单，这里补删，避免卸载后残留
Type: filesandordirs; Name: "{app}\runtime"
Type: filesandordirs; Name: "{app}\node_modules\@esbuild"
; 空壳目录收尾：本段是卸载的**最后一步**执行，排在官方卸载器清完自己之后。
; 编导选「连数据一起删」时 data\backups 已被 [Code] 清掉，这里把剩下的空目录也收掉，
; 不留一个空文件夹在 C:\Users\...\AppData\Local 下面；选「保留数据」时 data 还在，
; root 非空 → dirifempty 自动不生效，正是我们要的。
Type: dirifempty; Name: "{app}"
Type: dirifempty; Name: "{localappdata}\信息流编导工作台"

[Code]
var
  FailedLinks: TStringList;
  // 卸载时编导选了「连任务数据一起删」。在 InitializeUninstall 里问，在这里存，
  // 到 usPostUninstall（官方卸载器清完程序文件之后）才真正动手。
  PurgeData: Boolean;

// 数据根目录（程序目录在它下面的 app 子目录里，数据在 data 子目录里）。
// 卸载与升级都只碰程序目录，这个根目录本身默认原样留着。
function AppRoot(): String;
begin
  Result := ExpandConstant('{localappdata}') + '\信息流编导工作台';
end;

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
//   插升级旗标（launcher 见旗标拒启，免得清杀后又被双击拉起）→ stop.js 清进程
//   （记录里的 PID → 超时强杀进程树 → 按端口找孤儿实例，全在 stop.js 内部完成）
//   → 等引擎 DLL 释放（最长 60 秒）→ 运行时二进制原地覆盖 →
//   仍锁住则给出明确指引并中止，避免装成半吊子。
// 注意：node.exe / esbuild.exe **不在这里等释放**——本机实测「删除 exe」会被安全策略拦截
// （与占用无关），把它们放进等待清单只会白白失败；它们改由 RefreshRuntimeBinary 覆盖更新。
function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  NodeExe, StopJs: String;
  Code, CodeBk: Integer;
  OkStop, OkBk: Boolean;
begin
  Result := '';
  // 先清掉 1.2.0 及更早版本留下的两个「安全软件误报源」：
  //   · 卸载.exe      —— 已被 Defender 判为 Program:Script/Wacapew.A!ml 并隔离
  //   · kill-nodes.ps1 —— 配合 powershell -ExecutionPolicy Bypass 用的脚本
  // 删除失败（被占用/被安全策略拦）不拦安装，只是会留下一个没用的文件；
  // 它们都已不在新版本的安装清单里，卸载时不会再被引用。
  DeleteFile(ExpandConstant('{app}') + '\卸载.exe');
  DeleteFile(ExpandConstant('{app}') + '\kill-nodes.ps1');
  NodeExe := ExpandConstant('{app}') + '\runtime\node\node.exe';
  StopJs := ExpandConstant('{app}') + '\stop.js';
  if (FileExists(NodeExe) = False) or (FileExists(StopJs) = False) then
    Exit; // 首次安装没有可停的东西
  SaveStringToFile(UpgradeFlagPath(), '1', False);
  // stop.js 自己做三层兜底（记录里的 PID → 超时强杀进程树 → 按端口找孤儿实例），
  // 所以这里不再需要额外的 PowerShell 兜底脚本。
  Exec(NodeExe, '"' + StopJs + '"', ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Code);
  OkStop := (Code = 0);
  // 运行时二进制必须从安装包自身解出：升级老版本时 {app} 里可能还没有它们
  ExtractTemporaryFile('node.exe');
  ExtractTemporaryFile('esbuild.exe');
  // 升级前自动备份：此刻进程刚被清干净，复制出来的数据库不会是「写到一半」的半截状态。
  // 备份失败**不拦安装**——装不上比少一份备份更糟，但必须留下痕迹好事后补救。
  ExtractTemporaryFile('backup.js');
  OkBk := Exec(ExpandConstant('{tmp}') + '\node.exe',
    '"' + ExpandConstant('{tmp}') + '\backup.js" --tag=pre-upgrade',
    ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, CodeBk);
  // 诊断痕迹：写到数据目录（Inno 的 {tmp} 会随安装结束销毁，不能落那里）
  SaveStringToFile(ExpandConstant('{localappdata}') + '\信息流编导工作台\data\installer-prep.log',
    'stop.js execOk=' + IntToStr(Ord(OkStop)) + ' code=' + IntToStr(Code) + #13#10 +
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
  PurgeData := False;
  Result := True;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  GroupDir, AppDir: String;
begin
  if CurStep <> ssPostInstall then
    Exit;
  AppDir := ExpandConstant('{app}');
  // 开始菜单组（当前用户，免管理员可写）
  GroupDir := ExpandConstant('{userprograms}') + '\' + '{#MyAppName}';
  ForceDirectories(GroupDir);
  CreateLinkOrSkip(GroupDir + '\信息流编导工作台.lnk', '启动信息流编导工作台',
    'wscript.exe', '"' + AppDir + '\启动工作台.vbs"',
    AppDir, AppDir + '\runtime\node\node.exe');
  CreateLinkOrSkip(GroupDir + '\停止工作台.lnk', '停止信息流编导工作台',
    'wscript.exe', '"' + AppDir + '\停止工作台.vbs"',
    AppDir, '');
  // 桌面图标（当前用户桌面，免管理员安装下可写）
  CreateLinkOrSkip(ExpandConstant('{userdesktop}') + '\信息流编导工作台.lnk', '启动信息流编导工作台',
    'wscript.exe', '"' + AppDir + '\启动工作台.vbs"',
    AppDir, AppDir + '\runtime\node\node.exe');
  // 中文卸载入口：指向 Inno 官方卸载器，编导在程序目录和开始菜单里都能找到，双击即卸载。
  // 用 .lnk 而不是自带 exe —— 自带 exe 会被 Defender 的启发式规则当成脚本木马（1.2.0 实测）。
  // 指向的 unins000.exe 由 Inno 在 ssPostInstall 之前就已落盘，这里只管建链接。
  CreateLinkOrSkip(AppDir + '\卸载.lnk', '卸载信息流编导工作台',
    AppDir + '\unins000.exe', '', AppDir, AppDir + '\unins000.exe');
  CreateLinkOrSkip(GroupDir + '\卸载.lnk', '卸载信息流编导工作台',
    AppDir + '\unins000.exe', '', AppDir, AppDir + '\unins000.exe');
  if FailedLinks.Count > 0 then
    SuppressibleMsgBox(
      '以下快捷方式未能创建（多是被安全软件拦截，不影响程序本身使用）：' + #13#10 + #13#10 +
      FailedLinks.Text + #13#10 +
      '可以从开始菜单的「信息流编导工作台」启动，或打开程序目录双击「启动工作台」。',
      mbError, MB_OK, IDOK);
end;

// ── 卸载 ────────────────────────────────────────────────
// 1.2.1 起卸载入口就是 Inno 官方卸载器，所以「是否连数据一起删」这个问题要在这里问。
// 放在 InitializeUninstall 是因为它是官方文档给的「问完再决定要不要继续」的钩子：
// 返回 False 直接取消卸载，编导点「取消」时机器上什么都不会变。
// 用 SuppressibleMsgBox 而不是 MsgBox：静默卸载（/SILENT 等）下不弹框、直接取默认值，
// 默认是「只卸载程序，保留数据」——无人值守场景必须是安全的那一侧。
function InitializeUninstall(): Boolean;
var
  Ans: Integer;
begin
  PurgeData := False;
  Ans := SuppressibleMsgBox(
    '即将卸载「信息流编导工作台」。' + #13#10 + #13#10 +
    '任务、成片、导出文件和自动备份都放在下面这个目录里，卸载程序**默认不动它们**：' + #13#10 +
    '    ' + AppRoot() + #13#10 + #13#10 +
    '【是】只卸载程序，保留任务数据与备份（推荐，以后重装还能接着用）' + #13#10 +
    '【否】连任务数据、成片、登录会话和备份一起删掉' + #13#10 +
    '【取消】先不卸载',
    mbConfirmation, MB_YESNOCANCEL, IDYES);
  if Ans = IDCANCEL then
  begin
    Result := False;
    Exit;
  end;
  Result := True;
  if Ans = IDYES then
    Exit;
  // 选了「否」→ 这是不可逆操作，再要一次明确确认（默认按钮在「否」，防误触回车）。
  // 注意续行时别让 #13 落在行首：Inno 预处理器会把行首的 # 当成它自己的指令，报「Unknown preprocessor directive」。
  Ans := SuppressibleMsgBox(
    '再次确认：这会**永久删除**全部任务数据、成片、导出文件、妙思与数字人登录会话，以及自动备份。'
    + #13#10 + #13#10 + '删掉之后就找不回来了，确定要一起删吗？',
    mbCriticalError, MB_YESNO, IDNO);
  PurgeData := (Ans = IDYES);
end;

// [Icons] 段没有了，卸载时需自己删掉 [Code] 创建的快捷方式。
// 卸载本身不碰数据目录（它在 app 目录外侧），但编导往往是在卸载之后才发现「有份资料还要用」，
// 届时没备份就再也拿不回来。所以固定先备份一次；失败只记日志，绝不拦住卸载。
//
// 顺序说明（过去吃过「谁先跑」的亏）：停进程、备份、删快捷方式三件事**必须在同一处按序发生**。
// 官方文档里 usUninstall 是「实际卸载动作开始之前」，此刻 app 目录里的 stop.js / backup.js
// 都还在，所以这里能安全地先停后备份。
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  NodeExe, StopJs, BkJs, AppDir, Mark: String;
  Code, CodeBk: Integer;
begin
  AppDir := ExpandConstant('{app}');
  if CurUninstallStep = usUninstall then
  begin
    NodeExe := AppDir + '\runtime\node\node.exe';
    StopJs := AppDir + '\stop.js';
    BkJs := AppDir + '\backup.js';
    Mark := AppRoot() + '\uninstall.log';
    if FileExists(NodeExe) then
    begin
      // 先停进程：占用中的数据库复制出来可能是半截的（stop.js 内含孤儿实例兜底与强杀）
      if FileExists(StopJs) then
        Exec(NodeExe, '"' + StopJs + '"', AppDir, SW_HIDE, ewWaitUntilTerminated, Code)
      else
        Code := -1;
      if FileExists(BkJs) then
        Exec(NodeExe, '"' + BkJs + '" --tag=pre-uninstall',
          AppDir, SW_HIDE, ewWaitUntilTerminated, CodeBk)
      else
        CodeBk := -1;
      SaveStringToFile(Mark,
        'stop.js code=' + IntToStr(Code) + #13#10 +
        'backup code=' + IntToStr(CodeBk) + #13#10, False);
    end;
    DeleteFile(ExpandConstant('{userdesktop}') + '\信息流编导工作台.lnk');
    // 程序目录里的中文卸载入口不在安装清单里（是 [Code] 建的），得自己删，否则会剩在目录里
    DeleteFile(AppDir + '\卸载.lnk');
    // 开始菜单组整个删掉（含里面的 卸载.lnk）
    DelTree(ExpandConstant('{userprograms}') + '\' + '{#MyAppName}', True, True, True);
    Exit;
  end;
  // 官方卸载器已把程序文件清干净，这时才动数据（不可逆操作放在最后，前面任何一步失败都还来得及中止）
  if (CurUninstallStep = usPostUninstall) and PurgeData then
  begin
    DelTree(AppRoot() + '\data', True, True, True);
    DelTree(AppRoot() + '\backups', True, True, True);
    // 程序目录里可能还有**不在安装清单里**的运行期残留。已确认存在的一处：
    // worker 的锁与临时目录（app 目录下的 data 子目录，由 src/worker/*.ts 按进程工作目录解析出来的）。
    // 编导既然选了「全删」，就把整个程序目录一并清掉，别在 AppData 下留半个空壳。
    DelTree(AppDir, True, True, True);
    RemoveDir(AppDir);
    // 根目录里还有本程序自己写的几个日志（本次的 uninstall.log，以及 1.2.0 那个自研卸载器
    // 留下的 relocate/tool 日志）。它们挡着空壳目录回收，而且「全删」场景下已经没有审计价值
    // —— 逐条删掉，再收目录。若最终仍有残留，才写一份说明留着排查。
    DeleteFile(AppRoot() + '\uninstall.log');
    DeleteFile(AppRoot() + '\uninstall-purged.log');
    DeleteFile(AppRoot() + '\uninstall-relocate.log');
    DeleteFile(AppRoot() + '\uninstall-tool.log');
    RemoveDir(AppRoot());
    if DirExists(AppRoot()) then
      SaveStringToFile(AppRoot() + '\uninstall-purged.log',
        '已按编导选择清掉 data 与 backups，但根目录未能删除（多半还有文件被占用）。' + #13#10, False);
  end;
end;
