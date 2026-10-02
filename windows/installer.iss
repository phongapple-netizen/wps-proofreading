#define AppVersion GetEnv("WPS_RELEASE_VERSION")
#define BuildDir GetEnv("WPS_DIST_DIR")

[Setup]
AppId={{9EE6317B-F97E-4B4B-B190-9425FA90D447}
AppName=WPS 文本校改
AppVersion={#AppVersion}
AppPublisher=WPS Proofreading Contributors
AppPublisherURL=https://github.com/phongapple-netizen/wps-proofreading
AppSupportURL=https://github.com/phongapple-netizen/wps-proofreading/issues
DefaultDirName={localappdata}\Programs\WPSProofreading
DefaultGroupName=WPS 文本校改
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0
Compression=lzma2
SolidCompression=yes
CloseApplications=yes
RestartApplications=no
LicenseFile=..\LICENSE
OutputDir={#BuildDir}
OutputBaseFilename=WPS-Proofreading-{#AppVersion}-Windows-x64-Setup
UninstallDisplayIcon={app}\WPSProofreadingServer.exe

[Files]
Source: "{#BuildDir}\WPSProofreadingServer.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "安装说明.txt"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\LICENSE"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\THIRD_PARTY_NOTICES.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\SOURCE_PROVENANCE.md"; DestDir: "{app}"; Flags: ignoreversion

[UninstallRun]
Filename: "{sys}\taskkill.exe"; Parameters: "/F /IM WPSProofreadingServer.exe"; Flags: runhidden
Filename: "{app}\WPSProofreadingServer.exe"; Parameters: "--uninstall"; Flags: runhidden skipifdoesntexist

[Code]
var
  InstallFailed: Boolean;

function GetCustomSetupExitCode: Integer;
begin
  Result := 0;
  if InstallFailed then
    Result := 1;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  ExitCode: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /IM WPSProofreadingServer.exe', '', SW_HIDE, ewWaitUntilTerminated, ExitCode);
  Result := '';
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ExitCode: Integer;
  ServerPath: String;
begin
  if CurStep <> ssPostInstall then
    Exit;
  ServerPath := ExpandConstant('{app}\WPSProofreadingServer.exe');
  if (not Exec(ServerPath, '--install', '', SW_HIDE, ewWaitUntilTerminated, ExitCode)) or (ExitCode <> 0) then
  begin
    { ssPostInstall exceptions display an error but do not set Setup's exit code. }
    InstallFailed := True;
    RaiseException('安装未完成：本机服务检查、启动或 WPS 注册失败。请查看 %LOCALAPPDATA%\WPSProofreading\service-error.log。');
  end;
end;
