!define WISP_UPDATE_BACKGROUND "14191D"
!define WISP_UPDATE_FOREGROUND "E4EBE9"
!define WISP_UPDATE_MUTED "92A3AA"
!define WISP_UPDATE_ACCENT "77DBC6"

Var WispUpdatePercent
Var WispUpdateProgressProcess
Var WispUpdateLogo

!macro WispCreateUpdateControls
  ; Keep these on the GUI thread so they survive a failed installation.
  System::Call 'user32::CreateWindowExW(i 0, w "Static", p 0, i 0x40000203, i 0, i 0, i 0, i 0, p $HWNDPARENT, p 0, p 0, p 0) p.s'
  Pop $WispUpdateLogo
  System::Call 'user32::CreateWindowExW(i 0, w "Static", p 0, i 0x40000002, i 0, i 0, i 0, i 0, p $HWNDPARENT, p 0, p 0, p 0) p.s'
  Pop $WispUpdatePercent
!macroend

; Use dialog units so the layout follows the installer font and Windows scaling.
!macro WispPlaceControl control x y width height
  System::Call '*(i ${x}, i ${y}, i ${width}, i ${height}) p.r0'
  System::Call 'user32::MapDialogRect(p $HWNDPARENT, p r0)'
  System::Call '*$0(i.r1, i.r2, i.r3, i.r4)'
  System::Free $0
  System::Call 'user32::MoveWindow(p ${control}, i r1, i r2, i r3, i r4, i 1)'
!macroend

!macro WispStyleUpdateFrame
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6

  ; Compute the compact window size from the desired client area and existing frame.
  System::Call '*(i 0, i 0, i 272, i 137) p.r0'
  System::Call 'user32::MapDialogRect(p $HWNDPARENT, p r0)'
  System::Call '*$0(i, i, i.r5, i.r6)'
  System::Call 'user32::GetClientRect(p $HWNDPARENT, p r0)'
  System::Call '*$0(i, i, i.r1, i.r2)'
  IntOp $5 $5 - $1
  IntOp $6 $6 - $2
  System::Call 'user32::GetWindowRect(p $HWNDPARENT, p r0)'
  System::Call '*$0(i.r1, i.r2, i.r3, i.r4)'
  System::Free $0
  IntOp $3 $3 - $1
  IntOp $4 $4 - $2
  IntOp $5 $3 + $5
  IntOp $6 $4 + $6
  System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i 0, i 0, i r5, i r6, i 0x16)'
  ; DWMWA_USE_IMMERSIVE_DARK_MODE and DWMWA_CAPTION_COLOR.
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 20, *i 1, i 4)'
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT, i 35, *i 0x28231C, i 4)'

  SetCtlColors $HWNDPARENT "" "${WISP_UPDATE_BACKGROUND}"
  SetCtlColors $mui.Header.Text "${WISP_UPDATE_FOREGROUND}" "${WISP_UPDATE_BACKGROUND}"
  SetCtlColors $mui.Header.SubText "${WISP_UPDATE_MUTED}" "${WISP_UPDATE_BACKGROUND}"
  ShowWindow $mui.Header.Background ${SW_HIDE}
  ShowWindow $mui.Header.Image ${SW_HIDE}
  ShowWindow $mui.Branding.Background ${SW_HIDE}
  ShowWindow $mui.Branding.Text ${SW_HIDE}
  ShowWindow $mui.Line.Standard ${SW_HIDE}
  ShowWindow $mui.Line.FullWindow ${SW_HIDE}
  GetDlgItem $6 $HWNDPARENT 1036 ; Header divider in the MUI dialog.
  ShowWindow $6 ${SW_HIDE}
  GetDlgItem $6 $HWNDPARENT 1018 ; Placeholder for the native page.
  !insertmacro WispPlaceControl $6 24 113 224 8
  ShowWindow $mui.Button.Cancel ${SW_HIDE}

  ; Load the installer icon at the size of the logo control.
  !insertmacro WispPlaceControl $WispUpdateLogo 111 12 50 46
  System::Call 'kernel32::GetModuleHandleW(p 0) p.r6'
  System::Call 'user32::LoadImageW(p r6, p 103, i 1, i r4, i r4, i 0x8000) p.r6'
  SendMessage $WispUpdateLogo ${STM_SETICON} $6 0
  SetCtlColors $WispUpdateLogo "" "${WISP_UPDATE_BACKGROUND}"
  ShowWindow $WispUpdateLogo ${SW_SHOW}

  CreateFont $0 "Segoe UI" 17 700
  SendMessage $mui.Header.Text ${WM_SETFONT} $0 1
  System::Call 'gdi32::DeleteObject(p $mui.Header.Text.Font)'
  StrCpy $mui.Header.Text.Font $0
  System::Call 'user32::GetWindowLongW(p $mui.Header.Text, i -16) i.r5'
  IntOp $5 $5 | 1 ; SS_CENTER
  System::Call 'user32::SetWindowLongW(p $mui.Header.Text, i -16, i r5)'
  !insertmacro WispPlaceControl $mui.Header.Text 16 62 240 24
  !insertmacro WispPlaceControl $mui.Header.SubText 24 97 191 14

  ; Right-aligned percentage in the same row as the current installation stage.
  SetCtlColors $WispUpdatePercent "${WISP_UPDATE_ACCENT}" "${WISP_UPDATE_BACKGROUND}"
  ShowWindow $WispUpdatePercent ${SW_SHOW}
  CreateFont $5 "Segoe UI" 10 400
  SendMessage $mui.Header.SubText ${WM_SETFONT} $5 1
  CreateFont $5 "Segoe UI" 10 700
  SendMessage $WispUpdatePercent ${WM_SETFONT} $5 1
  !insertmacro WispPlaceControl $WispUpdatePercent 217 97 31 14

  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro WispStyleUpdateProgress
  Push $0
  Push $1
  Push $2
  Push $3
  Push $4

  SetCtlColors $mui.InstFilesPage "" "${WISP_UPDATE_BACKGROUND}"
  SetCtlColors $mui.InstFilesPage.Text "${WISP_UPDATE_FOREGROUND}" "${WISP_UPDATE_BACKGROUND}"
  !insertmacro WispPlaceControl $mui.InstFilesPage 24 113 224 8
  !insertmacro WispPlaceControl $mui.InstFilesPage.ProgressBar 0 0 224 5
  ShowWindow $mui.InstFilesPage.Text ${SW_HIDE}
  ShowWindow $mui.InstFilesPage.ShowLogButton ${SW_HIDE}

  ; Keep NSIS's native progress updates and apply Wisp's accent and track colors.
  System::Call 'uxtheme::SetWindowTheme(p $mui.InstFilesPage.ProgressBar, w "", w "")'
  SendMessage $mui.InstFilesPage.ProgressBar ${PBM_SETBARCOLOR} 0 0xC6DB77
  SendMessage $mui.InstFilesPage.ProgressBar ${PBM_SETBKCOLOR} 0 0x3E392E
  System::Call 'user32::InvalidateRect(p $HWNDPARENT, p 0, i 1)'

  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro WispStartProgress
  Push $0
  Push $1
  Push $2
  Push $3
  ; NSIS runs as a 32-bit process. Keep the process handle to join the helper
  ; before NSIS deletes the extracted executable.
  System::Call '*(i 68, p 0, p 0, p 0, i 0, i 0, i 0, i 0, i 0, i 0, i 0, &i2 0, &i2 0, p 0, p 0, p 0, p 0) p.r0'
  System::Call '*(p 0, p 0, i 0, i 0) p.r1'
  StrCpy $3 '"$PLUGINSDIR\wisp-update-helper.exe" --installer-progress $mui.InstFilesPage.ProgressBar $WispUpdatePercent'
  System::Call 'kernel32::CreateProcessW(w "$PLUGINSDIR\wisp-update-helper.exe", w r3, p 0, p 0, i 0, i 0, p 0, p 0, p r0, p r1) i.r2'
  ${If} $2 != 0
    System::Call '*$1(p.s, p.r2)'
    Pop $WispUpdateProgressProcess
    System::Call 'kernel32::CloseHandle(p r2)'
  ${EndIf}
  System::Free $1
  System::Free $0
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend

!macro WispStopProgress
  ${If} $WispUpdateProgressProcess != ""
    System::Call 'user32::SetPropW(p $WispUpdatePercent, w "WispProgressDone", p 1)'
    System::Call 'kernel32::WaitForSingleObject(p $WispUpdateProgressProcess, i 500)'
    System::Call 'kernel32::CloseHandle(p $WispUpdateProgressProcess)'
    StrCpy $WispUpdateProgressProcess ""
  ${EndIf}
!macroend

!macro WispTryCustomWindow
  Push $0
  Push $1
  Push $2
  ; HIGHCONTRASTW is 12 bytes in NSIS. Keep the native UI if Windows
  ; requests a contrast theme or if the settings query fails.
  System::Call '*(i 12, i 0, p 0) p.r0'
  System::Call 'user32::SystemParametersInfoW(i 0x42, i 12, p r0, i 0) i.r1'
  ${If} $1 != 0
    System::Call '*$0(i, i.r1)'
    IntOp $1 $1 & 1
    ${If} $1 == 0
      ${If} $WispUpdatePercent != 0
      ${AndIf} $WispUpdateLogo != 0
        !insertmacro WispStartProgress
        ${If} $WispUpdateProgressProcess != ""
          StrCpy $2 0
          ${Do}
            System::Call 'user32::GetPropW(p $WispUpdatePercent, w "WispProgressReady") p.r1'
            ${If} $1 != 0
              !insertmacro WispStyleUpdateFrame
              !insertmacro WispStyleUpdateProgress
              !insertmacro MUI_HEADER_TEXT "Updating Wisp AI" "Preparing the update…"
              System::Call 'user32::SetPropW(p $WispUpdatePercent, w "WispProgressStyled", p 1)'
              ${ExitDo}
            ${EndIf}
            System::Call 'kernel32::WaitForSingleObject(p $WispUpdateProgressProcess, i 25) i.r1'
            ${If} $1 != 258 ; WAIT_TIMEOUT
              !insertmacro WispStopProgress
              ${ExitDo}
            ${EndIf}
            IntOp $2 $2 + 1
            ${If} $2 == 48
              !insertmacro WispStopProgress
              ${ExitDo}
            ${EndIf}
          ${Loop}
        ${EndIf}
      ${EndIf}
    ${EndIf}
  ${EndIf}
  System::Free $0
  Pop $2
  Pop $1
  Pop $0
!macroend
