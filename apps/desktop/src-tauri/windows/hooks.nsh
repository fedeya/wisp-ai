; Only installed, read-only application resources are replaced. Conversations,
; memory, credentials and the Eve workspace live outside $INSTDIR in AppData.
; tauri.conf.json uses zlib to reduce the time spent extracting these resources.
!define MUI_CUSTOMFUNCTION_GUIINIT WispUpdateWindowInit

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

; Keep the updater visible after the desktop app hands off to NSIS. This also
; applies when the update was started by an older installed Wisp version.
Function WispUpdateWindowInit
  ClearErrors
  ${GetOptions} $CMDLINE "/UPDATE" $0
  ${IfNot} ${Errors}
    SendMessage $HWNDPARENT 0x000C 0 "STR:Updating Wisp AI"
    ShowWindow $HWNDPARENT 5
    BringToFront
  ${EndIf}
  !insertmacro WispUpdateStage "installer-visible"
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  !insertmacro WispUpdateStage "installer-ready"
  ${If} $UpdateMode = 1
    !insertmacro MUI_HEADER_TEXT "Updating Wisp AI" "Wisp will reopen automatically. Your chats and settings are kept."
    ${IfNot} ${Silent}
      SendMessage $HWNDPARENT 0x000C 0 "STR:Updating Wisp AI"
      ShowWindow $HWNDPARENT 5
      BringToFront
    ${EndIf}
  ${EndIf}
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File /oname=wisp-update-helper.exe "${MAINBINARYSRCPATH}"
  !insertmacro WispUpdateStage "helper-extracted"
  ExecWait '"$PLUGINSDIR\wisp-update-helper.exe" --prepare-update' $0
  ${If} $0 != 0
    Abort "Wisp could not stop safely. Finish the active reply, exit Wisp from the tray, and try again."
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
      Abort "Wisp resources are still in use. Exit Wisp from the tray and try again."
    ${EndIf}
  ${EndIf}
  !insertmacro WispUpdateStage "copying-files"
!macroend

!macro NSIS_HOOK_POSTINSTALL
  !insertmacro WispUpdateStage "files-installed"
  ${If} $UpdateMode = 1
    !insertmacro MUI_HEADER_TEXT "Opening Wisp AI" "The update is installed. Wisp is reopening automatically."
  ${EndIf}
!macroend
