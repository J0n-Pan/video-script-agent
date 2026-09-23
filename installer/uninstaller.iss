; ============================================================================
; 「卸载.exe」——信息流编导工作台的卸载入口
;
; 这是一个**独立的 Inno Setup 脚本**，单独编译成「卸载.exe」放进程序目录。
; 它自己不装任何东西，只做一个动作：驱动 Inno 自带的官方卸载器（unins000.exe）。
;
; 为什么不直接让编导去点 unins000.exe：
;   ① 名字是英文乱码，零技术编导不敢点，也不知道那是什么；
;   ② 官方卸载器**只删程序、不删数据**（这是刻意设计：删了任务就永久没了），
;      而「换人接管电脑」「回收测试机」这类场景需要连数据一起清。
;      这个入口就是补上那个「问一句」的分支。
;
; 关键约束（改这个文件前务必读）：
;   · 必须以 **同一个 AppId** 编译，卸载器才能被 Inno 识别为本产品的卸载程序；
;   · PrivilegesRequired 必须与主安装包一致（lowest），否则编导机器上权限不符；
;   · 不写 [Files]/[Registry]，它只是「执行一段代码」，跑完就退出；
;   · 千万别用 unins000.exe /{app} 的静默模式删数据 —— 数据目录在 {app} **外侧**，
;     必须由这里显式处理，且必须在官方卸载器跑完之后。
; ============================================================================

#define MyAppName "信息流编导工作台"
#define MyAppVersion GetEnv("WORKBENCH_VERSION")
#if MyAppVersion == ""
  #define MyAppVersion "0.0.0"
#endif
#define UninstallerVersion GetEnv("WORKBENCH_UNINST_VERSION")
#if UninstallerVersion == ""
  #define UninstallerVersion "0.0.0"
#endif
#define MyDataRoot "{localappdata}\信息流编导工作台"

[Setup]
; AppId 必须与主安装包完全一致：Inno 靠它把 unins000.exe 与产品对应起来
AppId={{8F2C1A55-6E7A-4C0B-9E3D-5A1B7C9D2E41}
AppName={#MyAppName}
AppVersion={#UninstallerVersion}
AppVerName={#MyAppName} {#UninstallerVersion}
AppPublisher={#MyAppName}
; 每用户安装（与主包一致）：编导机器上通常没有管理员权限
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
; 本 exe 的目标目录无所谓（它不落文件），但必须是合法值
DefaultDirName={#MyDataRoot}\app
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
DisableWelcomePage=yes
DisableFinishedPage=yes
; **不注册卸载信息、不建项、不改注册表**：它是「驱动器」，不是「安装包」
CreateUninstallRegKey=no
Uninstallable=no
; 压缩无所谓（内容几乎为空），但保持与主包一致的产出目录约定
Compression=lzma2/fast
SolidCompression=yes
OutputDir={#MyOutDir}
OutputBaseFilename=卸载
WizardStyle=modern
; 不申请管理员，也不要求关闭任何程序
CloseApplications=no
RestartApplications=no
; 让它看起来就是个普通工具而非安装向导
SetupLogging=no
; 中文界面：编导看到的所有文案必须是中文
[Languages]
Name: "chinesesimp"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Messages]
chinesesimp.SetupAppTitle=卸载 {#MyAppName}
chinesesimp.SetupWindowTitle=卸载 {#MyAppName}

[Code]
{ ============================================================================
  「卸载.exe」的全部逻辑。

  设计要点（改之前先读）：
   · 这个 exe 走 **InitializeSetup 里做完所有事、然后返回 False** 的路子：
     返回 False = 「不安装任何东西」，Inno 不会创建向导窗口、不会落文件，
     只在我们的 MsgBox 之间走一遍，跑完就退出。
   · 官方卸载器（unins000.exe）是**异步**的：必须轮询等它把文件释放完，
     否则紧接着删目录必然失败（文件还被占用）。
   · 数据目录在程序目录 **外侧**，官方卸载器不会碰，必须这里显式处理。
   · 所有删除失败都只记日志、不中断 —— 宁可留残留，也不能把用户卡在半路。
  ============================================================================ }

function NL(): String;
begin
  Result := #13#10;
end;

{ 数据 / 备份 / 程序目录（都挂在 localappdata 下） }
function RootDir(): String;
begin
  Result := ExpandConstant('{localappdata}') + '\信息流编导工作台';
end;

function AppDir(): String;
begin
  Result := RootDir() + '\app';
end;

function DataDir(): String;
begin
  Result := RootDir() + '\data';
end;

function BackupDir(): String;
begin
  Result := RootDir() + '\backups';
end;

function OfficialUninstaller(): String;
begin
  Result := AppDir() + '\unins000.exe';
end;

function FailLog(): String;
begin
  Result := RootDir() + '\uninstall-delete-failed.log';
end;

{ Inno 的 BoolToStr 是单参版本，这里自己写一个带文案的，避免依赖具体签名 }
function ChoiceText(const Purge: Boolean): String;
begin
  if Purge then
    Result := '连数据一起删'
  else
    Result := '只卸载程序';
end;

{ 目录体积（MB，向上取整）：用来在对话框里告诉用户「要删掉多少东西」。
  · 用 Int64 累加，视频目录动辄几十 GB，Int32 会溢出成负数。
  · 目录不存在直接返回 0（dialog 文案里会显示 0 MB，不会崩）。 }
function DirSizeMB(const Dir: String): Int64;
var
  FindRec: TFindRec;
  Total: Int64;
  Sub: String;
begin
  Result := 0;
  if not DirExists(Dir) then
    Exit;

  Total := 0;
  if FindFirst(Dir + '\*', FindRec) then
  begin
    try
      repeat
        if (FindRec.Name <> '.') and (FindRec.Name <> '..') then
        begin
          if (FindRec.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0 then
          begin
            Sub := Dir + '\' + FindRec.Name;
            Total := Total + DirSizeMB(Sub) * 1024 * 1024;
          end
          else
            Total := Total + Int64(FindRec.SizeHigh) * 4294967296 + Int64(FindRec.SizeLow);
        end;
      until not FindNext(FindRec);
    finally
      FindClose(FindRec);
    end;
  end;

  Result := (Total + 1024 * 1024 - 1) div (1024 * 1024);
end;

{ 递归删除。失败写日志、继续往下走，不抛异常、不中断。 }
procedure DeleteTreeLogged(const Dir, LogPath: String);
var
  FindRec: TFindRec;
  Sub: String;
begin
  if not DirExists(Dir) then
    Exit;
  if FindFirst(Dir + '\*', FindRec) then
  begin
    try
      repeat
        if (FindRec.Name <> '.') and (FindRec.Name <> '..') then
        begin
          Sub := Dir + '\' + FindRec.Name;
          if (FindRec.Attributes and FILE_ATTRIBUTE_DIRECTORY) <> 0 then
            DeleteTreeLogged(Sub, LogPath)
          else if not DeleteFile(Sub) then
            SaveStringToFile(LogPath, '删除失败（可能被占用）：' + Sub + NL(), True);
        end;
      until not FindNext(FindRec);
    finally
      FindClose(FindRec);
    end;
  end;
  if not RemoveDir(Dir) then
    SaveStringToFile(LogPath, '目录残留（可能仍被占用）：' + Dir + NL(), True);
end;

{ 停工作台：先按 pids.json 精确关，再按可执行路径兜底清杀 }
procedure StopWorkbench();
var
  NodeExe, StopJs, Ps1: String;
  Code: Integer;
begin
  NodeExe := AppDir() + '\runtime\node\node.exe';
  StopJs := AppDir() + '\stop.js';
  Ps1 := AppDir() + '\kill-nodes.ps1';
  if FileExists(NodeExe) and FileExists(StopJs) then
    Exec(NodeExe, '"' + StopJs + '"', AppDir(), SW_HIDE, ewWaitUntilTerminated, Code);
  if FileExists(Ps1) then
    Exec('powershell.exe',
      '-NoProfile -ExecutionPolicy Bypass -File "' + Ps1 + '"',
      AppDir(), SW_HIDE, ewWaitUntilTerminated, Code);
end;

{ 等官方卸载器把自身删掉（删完自己就消失了），再留一点时间给系统释放句柄 }
procedure WaitForUninstallerGone(MaxMs: Integer);
var
  Elapsed: Integer;
begin
  Elapsed := 0;
  while (Elapsed < MaxMs) and FileExists(OfficialUninstaller()) do
  begin
    Sleep(500);
    Elapsed := Elapsed + 500;
  end;
  Sleep(1500);
end;

{ 系统临时目录：优先环境变量 TEMP/TMP，都不存在时退回 Windows 目录下的 Temp。
  不用 Inno 内置的临时目录常量 —— 那是随进程创建的，进程一退就被清，
  而临时副本那时还在运行。 }
function SysTemp(): String;
var
  T: String;
begin
  T := GetEnv('TEMP');
  if T = '' then
    T := GetEnv('TMP');
  if T = '' then
    T := ExpandConstant('{win}') + '\Temp';
  { 去掉可能存在的结尾反斜杠，避免拼出双斜杠 }
  while (Length(T) > 0) and (T[Length(T)] = '\') do
    T := Copy(T, 1, Length(T) - 1);
  Result := T;
end;

{ 判断当前这份 exe 是不是「正从程序目录里跑」—— 是则需要挪走。
  两种情况都不需要挪：
    · 已经在系统临时目录里（说明是挪过来的第二趟，再挪会无限递归）；
    · 不在 app 目录下（例如维护人员手工拷出来跑），本来就不占着程序目录。 }
function NeedsRelocate(): Boolean;
var
  SelfPath: String;
begin
  SelfPath := ExpandConstant('{srcexe}');
  Result := (CompareText(ExtractFileDir(SelfPath), SysTemp()) <> 0)
    and (Pos('\app\', SelfPath) > 0);
end;

{ 把自己从程序目录挪到系统临时目录再重启一次。
  为什么必须这么做：编导是从程序目录里的「卸载.exe」双击进来的，这个文件当时**被自己占用**，
  官方卸载器删到它时会失败 —— 结果是卸载"成功"了但程序目录里永远留着一个删不掉的
  「卸载.exe」，再点它还会跑一遍，看起来像没卸载干净。
  做法：复制自身到系统临时目录，重新拉起，然后本进程立刻退出，
  程序目录里那份就不再被占用，可被正常删除。
  · 用系统临时目录而不是 Inno 内置的临时目录：后者会随本进程退出被清理，
    而临时副本那时还在运行，会被连带删掉（Windows 上删运行中的 exe 会失败、
    但目录清理逻辑可能干扰），用系统临时目录最稳。
  · 临时副本留到系统清理即可 —— 它只是一个几百 KB 的 exe。 }
procedure RelocateAndRelaunch();
var
  SelfPath, TempCopy: String;
  Code: Integer;
begin
  SelfPath := ExpandConstant('{srcexe}');
  TempCopy := SysTemp() + '\信息流编导工作台-卸载.exe';
  if not CopyFile(SelfPath, TempCopy, False) then
    Exit;
  Exec(TempCopy, '', '', SW_SHOW, ewNoWait, Code);
end;

function InitializeSetup(): Boolean;
var
  Ans: Integer;
  DataMB, BkMB: Int64;
  Msg: String;
  PurgeData: Boolean;
begin
  { 返回 False = 本 exe 不安装任何东西；所有事都在这里做完 }
  Result := False;

  { 第一件事：确保自己不是正从程序目录里运行，否则卸不干净自己 }
  if NeedsRelocate() then
  begin
    RelocateAndRelaunch();
    Exit;
  end;

  if not FileExists(OfficialUninstaller()) then
  begin
    MsgBox('没有找到「信息流编导工作台」的安装记录，可能已经被卸载过了。'
      + NL() + NL()
      + '如果还有残留数据想手动清理，位置在这里：' + NL() + DataDir(),
      mbInformation, MB_OK);
    Exit;
  end;

  DataMB := DirSizeMB(DataDir());
  BkMB := DirSizeMB(BackupDir());

  Msg := '这会把「信息流编导工作台」从这台电脑上卸载。' + NL() + NL()
    + '【只卸载程序】保留你的任务、脚本、视频和自动备份（合计约 '
    + IntToStr(DataMB + BkMB) + ' MB）。' + NL()
    + '    以后重新安装，原来的东西还在。' + NL() + NL()
    + '【连数据一起删】把上面这些全部永久删除，无法恢复。' + NL()
    + '    换人使用这台电脑、或回收测试机时才需要。' + NL() + NL()
    + '点「是」  = 只卸载程序（推荐）' + NL()
    + '点「否」  = 连任务数据一起删除' + NL()
    + '点「取消」= 什么都不做';

  { 默认按钮是「是」= 保留数据：手滑点回车也不会出事 }
  Ans := MsgBox(Msg, mbConfirmation, MB_YESNOCANCEL);
  if Ans = IDCANCEL then
    Exit;

  PurgeData := (Ans = IDNO);

  if PurgeData then
  begin
    Ans := MsgBox('请再确认一次：要永久删除全部任务数据吗？' + NL() + NL()
      + '包含任务与脚本、原始视频、导出结果、数字人成品、妙思登录状态（约 '
      + IntToStr(DataMB) + ' MB），以及自动备份（约 ' + IntToStr(BkMB) + ' MB）。' + NL() + NL()
      + '删除后无法恢复。确定请点「是」。', mbError, MB_YESNO);
    if Ans <> IDYES then
      PurgeData := False;
  end;

  StopWorkbench();

  { 诊断痕迹：万一卸载不干净，维护人员能看出走到了哪一步 }
  SaveStringToFile(RootDir() + '\uninstall-tool.log',
    '卸载入口启动' + NL()
    + '数据目录=' + DataDir() + NL()
    + '数据大小MB=' + IntToStr(DataMB) + NL()
    + '备份大小MB=' + IntToStr(BkMB) + NL()
    + '用户选择=' + ChoiceText(PurgeData) + NL(), False);

  { 驱动官方卸载器：/SILENT 不再弹它自己的向导；/NORESTART 不自动重启 }
  Exec(OfficialUninstaller(), '/SILENT /NORESTART', AppDir(), SW_SHOW, ewNoWait, Ans);
  WaitForUninstallerGone(120000);

  if PurgeData then
  begin
    DeleteTreeLogged(DataDir(), FailLog());
    DeleteTreeLogged(BackupDir(), FailLog());
    { 程序目录可能还剩被占用的散件，再清一层 }
    DeleteTreeLogged(AppDir(), FailLog());
    DeleteTreeLogged(RootDir(), FailLog());
  end;

  { 桌面快捷方式兜底删除（主安装包自己也会删，这里防它提前退出） }
  DeleteFile(ExpandConstant('{userdesktop}') + '\信息流编导工作台.lnk');

  if PurgeData then
    MsgBox('卸载完成。' + NL() + NL()
      + '程序与任务数据都已删除。', mbInformation, MB_OK)
  else
    MsgBox('卸载完成。' + NL() + NL()
      + '程序已删除，你的任务数据保留在这里：' + NL()
      + DataDir() + NL() + NL()
      + '自动备份保留在这里：' + NL() + BackupDir() + NL() + NL()
      + '（以后重新安装，原来的东西还在）', mbInformation, MB_OK);
end;
