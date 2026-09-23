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
LZMAUseSeparateProcess=yes
LZMANumBlockThreads=4
OutputDir={#MyOutDir}
OutputBaseFilename=信息流编导工作台-Setup-{#MyAppVersion}
UninstallDisplayName={#MyAppName} {#MyAppVersion}
UninstallDisplayIcon={app}\启动工作台.vbs
SetupIconFile=
WizardStyle=modern
WizardSmallImageFile=
; 升级时先停掉正在跑的工作台，避免文件占用
CloseApplications=yes
CloseApplicationsFilter=node.exe
RestartApplications=no

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
Source: "{#MyPayload}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

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
Filename: "wscript.exe"; Parameters: """{app}\停止工作台.vbs"""; Flags: runhidden

[UninstallDelete]
; 只删程序目录（Inno 默认行为）；数据目录在 {localappdata}\信息流编导工作台\data，
; 不在 {app} 内，因此卸载与升级都不会碰到编导的任务、资料包和成片。
Type: files; Name: "{app}\.env"

[Code]
var
  FailedLinks: TStringList;

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
procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep <> usUninstall then
    Exit;
  DeleteFile(ExpandConstant('{userdesktop}') + '\信息流编导工作台.lnk');
  DelTree(ExpandConstant('{userprograms}') + '\' + '{#MyAppName}', True, True, True);
end;
