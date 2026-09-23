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
function BoolText(const B: Boolean): String;
begin
  if B then
    Result := '是'
  else
    Result := '否';
end;

{ 把文本写成 UTF-16LE + BOM 的文件。
  ★ 必须这样写：wscript.exe 读 .vbs 时不认无 BOM 的 UTF-8，会按 ANSI(GBK) 解释，
    中文全部变乱码 → 报「无效字符」800A0408。仓库里的 .vbs 也都是 UTF-16LE+BOM 存的，
    构建脚本里专门有一步「脚本转码（BOM）」。

  ★ 这里有三个曾经踩过的坑（2026-09-23，改之前务必看完）：
    ① 别用 SaveStringToFile 写 —— 它的形参是 AnsiString，会把 Unicode 字符按系统
       代码页（中文机上是 GBK）转换，转不出的字符直接变成 '?'。
       实测首字节写出 3f 74（= '?t'）而不是 ff fe，整个脚本作废。
    ② 别自己算「低字节/高字节」再拼两个小时 —— TFileStream.WriteBuffer 接的是
       **String**，它把每个 UTF-16 码元原样展开成 2 个字节（小端）。
       所以一个码元就已经是 2 字节，再手动拆一次会把长度翻倍。
       正确做法：BOM 用单个字符 #$FEFF（它的字节表示正好是 FF FE），
       正文逐字符原样追加即可。
    ③ ★ Count 参数必须传**字节数**（= 字符数 × 2），不是字符数！
       传 Length(Raw) 会只写出一半的字节 → 文件字节数为奇数 →
       末尾那个字符被截断成半个码元 → wscript 报
       「Microsoft VBScript 编译器错误: 无效字符」(行 1 列 1)。
       这个错看起来像 BOM 问题，其实是长度算错，极难联想，务必记住。 }
procedure SaveStringToFileUTF16(const Path, Text: String);
var
  F: TFileStream;
  Raw: String;
begin
  Raw := #$FEFF + Text;
  F := TFileStream.Create(Path, fmCreate);
  try
    { Count 是字节数：每个 UTF-16 码元占 2 字节 }
    F.WriteBuffer(Raw, Length(Raw) * 2);
  finally
    F.Free;
  end;
end;

{ 把来源字符串里的 Needle 全换成 Repl（From/To 是 Pascal 保留字，不能用） }
function ReplaceStr(const S, Needle, Repl: String): String;
var
  P: Integer;
  R: String;
begin
  R := S;
  repeat
    P := Pos(Needle, R);
    if P > 0 then
      R := Copy(R, 1, P - 1) + Repl + Copy(R, P + Length(Needle), Length(R));
  until P = 0;
  Result := R;
end;

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


{ 排查用的日志：整个卸载过程只写这一个文件，方便事后看走到哪一步 }
function RelocateLog(): String;
begin
  Result := RootDir() + '\uninstall-relocate.log';
end;

procedure LogRelocate(const Line: String);
begin
  { 目录可能已被删（卸载走完一遍后再点一次）→ 先补建，否则日志写不进去、
    排查时又会变成「什么都没留下」的假象。 }
  if not DirExists(RootDir()) then
    ForceDirectories(RootDir());
  SaveStringToFile(RelocateLog(), Line + NL(), True);
end;

{ 启动一个**分离的清理器**，它等本进程退出后删除残留。
  ★ 为什么不再用「复制自身 → 重启」那套（2026-09-23 换掉）：
    InitializeSetup 阶段既读不了 srcexe（CopyFile=0、TFileStream 抛异常）、
    也改不了它的名（RenameFile=0），而 ParamStr(0) 只是 Inno 解包出来的镜像，
    复制它再运行毫无意义。那条路在本阶段**物理上走不通**。
  ★ 新做法：把「删干净自己」这件事外包给一个不占 app 目录的外部进程。
    · 用 VBS（由 Windows 脚本宿主执行）而不是 bat：VBS 可 SW_HIDE 启动、无黑框闪现；
    · 脚本在**系统临时目录**里生成，运行完自删，不留痕；
    · 它先轮询等本 exe 退出（最长 60 秒），再补删 app 目录与桌面快捷方式；
    · 本进程随后立刻退出，于是 app\卸载.exe 的占用被释放，能被删掉。
  ★ 脚本内容必须写成 UTF-16LE+BOM（见 SaveStringToFileUTF16 的三个坑），
    且 Exec 必须用 ewNoWait —— 我们要立刻返回、让本进程尽快退出释放占用。 }
procedure LaunchCleanupShim(const Purge: Boolean);
var
  ShimPath, Shim, PurgeFlag: String;
  Code, ShimBytes: Integer;
  Ok: Boolean;
begin
  ShimPath := SysTemp() + '\信息流编导工作台-清理.vbs';
  if Purge then
    PurgeFlag := 'True'
  else
    PurgeFlag := 'False';

  { 用单引号包裹 VBS 里的字符串；路径里的单引号极少见，但为稳妥做一次转义 }
  Shim :=
    'Option Explicit' + NL() +
    'Dim fso, sh, me_exe, root, app, data, bak, desk' + NL() +
    'Set fso = CreateObject("Scripting.FileSystemObject")' + NL() +
    'Set sh  = CreateObject("WScript.Shell")' + NL() +
    'me_exe = "' + ReplaceStr(ExpandConstant('{srcexe}'), '"', '""') + '"' + NL() +
    'root   = fso.GetParentFolderName(fso.GetParentFolderName(me_exe))' + NL() +
    'app    = fso.GetParentFolderName(me_exe)' + NL() +
    'data   = root & "\data"' + NL() +
    'bak    = root & "\backups"' + NL() +
    'desk   = sh.SpecialFolders("Desktop") & "\信息流编导工作台.lnk"' + NL() +
    '' + NL() +
    ''' 等本进程（卸载.exe）退出，最长 60 秒' + NL() +
    'Dim i, still' + NL() +
    'For i = 1 To 120' + NL() +
    '  still = False' + NL() +
    '  On Error Resume Next' + NL() +
    '  Dim h: Set h = fso.GetFile(me_exe)' + NL() +
    '  If Err.Number <> 0 Then still = False Else still = True' + NL() +
    '  Err.Clear' + NL() +
    '  On Error Goto 0' + NL() +
    '  If Not still Then Exit For' + NL() +
    '  WScript.Sleep 500' + NL() +
    'Next' + NL() +
    'WScript.Sleep 1200' + NL() +
    '' + NL() +
    ''' 删不掉的（例如仍在被占用）就跳过，不中断' + NL() +
    'On Error Resume Next' + NL() +
    'If ' + PurgeFlag + ' Then' + NL() +
    '  fso.DeleteFolder data, True' + NL() +
    '  fso.DeleteFolder bak, True' + NL() +
    'End If' + NL() +
    'fso.DeleteFile app & "\卸载.exe", True' + NL() +
    'fso.DeleteFile desk, True' + NL() +
    'If ' + PurgeFlag + ' Then fso.DeleteFolder root, True' + NL() +
    'Err.Clear' + NL() +
    'On Error Goto 0' + NL() +
    '' + NL() +
    ''' 自删（脚本自己从 TEMP 里消失）' + NL() +
    'On Error Resume Next' + NL() +
    'fso.DeleteFile WScript.ScriptFullName, True' + NL();

  { VBS 必须 UTF-16LE + BOM，否则脚本宿主按 ANSI 读、中文变乱码/报错 }
  SaveStringToFileUTF16(ShimPath, Shim);

  { ★ 自检：UTF-16LE 文件的字节数必须是**偶数**。
    写成奇数 = 末字节被截断 = 脚本宿主报「无效字符」而完全不执行，
    且现象与「BOM 写错」一模一样、极难排查（2026-09-23 实际踩了 2 小时）。
    这里主动算一次并记进日志，一旦再出现编码问题可以一眼定位。 }
  ShimBytes := 0;
  if FileSize(ShimPath, ShimBytes) and ((ShimBytes mod 2) <> 0) then
    LogRelocate('★ 严重：清理脚本字节数为奇数(' + IntToStr(ShimBytes)
      + ')，脚本不会被脚本宿主执行，app 目录会残留「卸载.exe」');

  Ok := Exec('wscript.exe', '"' + ShimPath + '"', '', SW_HIDE, ewNoWait, Code);
  LogRelocate('LaunchCleanupShim: 脚本=' + ShimPath + ' 生成=' + BoolText(FileExists(ShimPath))
    + ' 字节=' + IntToStr(ShimBytes) + ' Exec=' + BoolText(Ok) + ' Code=' + IntToStr(Code));
  if not FileExists(ShimPath) then
    LogRelocate('警告：清理脚本没写成功，app 目录可能残留「卸载.exe」');
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

  { 进门先留痕：万一后面哪一步静默失败，至少能确认「InitializeSetup 被调到了」 }
  LogRelocate('==== 卸载入口被调用 ' + GetDateTimeString('yyyy-mm-dd hh:nn:ss', '-', ':') + ' ====');

  { ★ 不再「复制自身到 TEMP 再重启」（2026-09-23 弃用，原因见 LaunchCleanupShim 注释）。
    改为：本进程走完全程后，交给一个分离的 VBS 清理器去删 app\卸载.exe 自己。
    这里只记录一下我们是从哪儿跑的，便于排查。 }
  LogRelocate('ParamStr(0)=' + ParamStr(0));
  LogRelocate('srcexe=' + ExpandConstant('{srcexe}'));

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
    { 程序目录可能还剩被占用的散件，再清一层。
      注意 app\卸载.exe 必然删不掉 —— 那正是本进程自己，会在下面交给清理器。 }
    DeleteTreeLogged(AppDir(), FailLog());
    DeleteTreeLogged(RootDir(), FailLog());
  end;

  { 桌面快捷方式兜底删除（主安装包自己也会删，这里防它提前退出） }
  DeleteFile(ExpandConstant('{userdesktop}') + '\信息流编导工作台.lnk');

  { ★ 关键收尾：启一个分离的清理器，等本进程退出后删掉 app\卸载.exe。
    必须在弹完成提示**之前**启动，否则用户看提示的这段时间里它还没开始干活。 }
  LaunchCleanupShim(PurgeData);

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
