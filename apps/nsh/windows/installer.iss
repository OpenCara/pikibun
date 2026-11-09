; The Windows installer for Pikibun's client (Inno Setup 6, preinstalled on GitHub's Windows runners), around the app
; directory `nsh package --target windows` writes: Pikibun.exe with its icon, and the bundle beside it in nsh\.
;
;   ISCC.exe /DAppVersion=1.2.3-beta.1 /DNumericVersion=1.2.3 /DSourceDir=<that directory> /DOutputDir=<out> installer.iss
;
; With /DSign and "/Spikibun=<sign command, $f the file>", the installer and the uninstaller in it are signed with it.
;
; It installs for the current user, into %LOCALAPPDATA%\Programs\Pikibun, so it needs no administrator (one can
; choose all users in its first dialog), adds Pikibun to the Start menu and, if asked, the desktop, and registers an
; uninstaller. A newer installer updates in place. Built and tested by .github/workflows/release-app.yml.

#ifndef AppVersion
  #error Pass the version: /DAppVersion=1.2.3
#endif
#ifndef SourceDir
  #error Pass the app directory nsh package wrote: /DSourceDir=...
#endif
#ifndef OutputDir
  #define OutputDir "."
#endif
; The file version Windows shows takes only numbers: the version without a prerelease suffix.
#ifndef NumericVersion
  #define NumericVersion AppVersion
#endif

[Setup]
; Never change it: Windows knows an installed Pikibun, to update and uninstall, by this id.
AppId={{6F1C2B8E-3D4A-4B7E-9C51-2A8F0E7D4B39}
AppName=Pikibun
AppVersion={#AppVersion}
AppVerName=Pikibun {#AppVersion}
VersionInfoVersion={#NumericVersion}
AppPublisher=OpenCara
AppPublisherURL=https://pikibun.com
AppSupportURL=https://github.com/OpenCara/pikibun/issues
DefaultDirName={autopf}\Pikibun
DefaultGroupName=Pikibun
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\Pikibun.exe
UninstallDisplayName=Pikibun
OutputDir={#OutputDir}
OutputBaseFilename=Pikibun-{#AppVersion}-windows-x64-setup
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
#ifdef Sign
SignTool=pikibun
SignedUninstaller=yes
#endif
; Pikibun running is closed to update it, and started again afterwards.
CloseApplications=yes
RestartApplications=yes

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: unchecked

[Files]
; The whole directory: an update replaces the bundle, and files an older version had and this one hasn't go below.
Source: "{#SourceDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs

[InstallDelete]
Type: filesandordirs; Name: "{app}\nsh"

[Icons]
Name: "{autoprograms}\Pikibun"; Filename: "{app}\Pikibun.exe"
Name: "{autodesktop}\Pikibun"; Filename: "{app}\Pikibun.exe"; Tasks: desktopicon

[Run]
Filename: "{app}\Pikibun.exe"; Description: "{cm:LaunchProgram,Pikibun}"; Flags: nowait postinstall skipifsilent
