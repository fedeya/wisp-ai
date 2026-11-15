; Only installed, read-only application resources are replaced. Conversations,
; memory, credentials and the Eve workspace live outside $INSTDIR in AppData.
; tauri.conf.json uses zlib to reduce the time spent extracting these resources.
!define MUI_CUSTOMFUNCTION_GUIINIT WispUpdateWindowInit
!include "${__FILEDIR__}\update-window.nsh"

Var WispUpdateLog
!macro WispUpdateStage stage
  Push $0
  Push $1
  ClearErrors
  ${GetOptions} $CMDLINE "/UPDATE" $0
  ${IfNot} ${Errors}
    ${If} $WispUpdateLog == ""
      ReadEnvStr $WispUpdateLog "WISP_DATA_DIR"
      ${If} $WispUpdateLog == ""
        StrCpy $WispUpdateLog "$APPDATA\com.wisp.ai"
      ${EndIf}
      CreateDirectory "$WispUpdateLog\runtime"
      StrCpy $WispUpdateLog "$WispUpdateLog\runtime\update.log"
    ${EndIf}
    FileOpen $0 $WispUpdateLog a
    ${IfNot} ${Errors}
      FileSeek $0 0 END
      System::Call 'kernel32::GetTickCount64()l.r1'
      FileWrite $0 "$1 ${stage}$\r$\n"
      FileClose $0
    ${EndIf}
  ${EndIf}
  ClearErrors
  Pop $1
  Pop $0
!macroend

Function WispUpdateWindowInit
  ClearErrors
  ${GetOptions} $CMDLINE "/UPDATE" $0
  ${IfNot} ${Errors}
    ClearErrors
    ${GetOptions} $CMDLINE "/P" $0
    ${IfNot} ${Errors}
      !insertmacro WispCreateUpdateSignal
    ${EndIf}
  ${EndIf}
FunctionEnd

Function .onGUIEnd
  !insertmacro WispStopProgress
FunctionEnd

!macro WispAbortInstall message
  ${If} $UpdateMode = 1
  ${AndIf} $PassiveMode = 1
  ${AndIfNot} ${Silent}
  ${AndIf} $WispUpdateProgressProcess == ""
    MessageBox MB_OK|MB_ICONEXCLAMATION "${message}"
  ${EndIf}
  Abort "${message}"
!macroend

!macro NSIS_HOOK_PREINSTALL
  !insertmacro WispUpdateStage "installer-ready"
  ${If} $UpdateMode = 1
    !insertmacro MUI_HEADER_TEXT "Updating Wisp AI" "Wisp will reopen automatically."
    ${IfNot} ${Silent}
      SendMessage $HWNDPARENT ${WM_SETTEXT} 0 "STR:Wisp AI"
    ${EndIf}
  ${EndIf}
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=wisp-update-helper.exe "${MAINBINARYSRCPATH}"
  !insertmacro WispUpdateStage "helper-extracted"
  ${If} $UpdateMode = 1
  ${AndIf} $PassiveMode = 1
  ${AndIfNot} ${Silent}
    !insertmacro WispTryCustomWindow
  ${EndIf}
  ${If} $UpdateMode = 1
  ${AndIfNot} ${Silent}
    ${If} $WispUpdateProgressProcess == ""
      ShowWindow $HWNDPARENT ${SW_SHOW}
      BringToFront
      !insertmacro WispUpdateStage "installer-visible"
    ${Else}
      !insertmacro WispUpdateStage "updater-ready"
    ${EndIf}
  ${EndIf}
  ExecWait '"$PLUGINSDIR\wisp-update-helper.exe" --prepare-update' $0
  ${If} $0 != 0
    !insertmacro WispAbortInstall "Wisp could not stop safely. Finish the active reply, exit Wisp from the tray, and try again."
  ${EndIf}
  !insertmacro WispUpdateStage "bridge-stopped"
  SetOutPath "$INSTDIR"
  !insertmacro CheckIfAppIsRunning "$INSTDIR\${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
  ; Existing Wisp executable + build marker identify the application-owned tree.
  ; A fresh/custom directory without these markers is never recursively removed.
  ${If} ${FileExists} "$INSTDIR\${MAINBINARYNAME}.exe"
  ${AndIf} ${FileExists} "$INSTDIR\payload\BUILD.json"
  ${AndIf} ${FileExists} "$INSTDIR\payload\package.json"
    RMDir /r "$INSTDIR\payload"
    ${If} ${FileExists} "$INSTDIR\payload\*.*"
      !insertmacro WispAbortInstall "Wisp resources are still in use. Exit Wisp from the tray and try again."
    ${EndIf}
  ${EndIf}
  !insertmacro WispUpdateStage "copying-files"
  ${If} $WispUpdateProgressProcess != ""
    System::Call 'user32::SetPropW(p $WispUpdateSignal, w "WispProgressInstalling", p 1)'
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro WispUpdateStage "files-installed"
  ${If} $WispUpdateProgressProcess != ""
    System::Call 'user32::SetPropW(p $WispUpdateSignal, w "WispProgressSucceeded", p 1)'
    !insertmacro WispStopProgress
  ${ElseIf} $UpdateMode = 1
    !insertmacro MUI_HEADER_TEXT "Opening Wisp AI" "The update is installed. Wisp is reopening automatically."
  ${EndIf}
!macroend
