!include LogicLib.nsh
!include nsDialogs.nsh

!ifndef BUILD_UNINSTALLER
Var AssociateMdxCheckbox
Var AssociateMdCheckbox
Var FileContextCheckbox
Var FolderContextCheckbox
Var AssociateMdxState
Var AssociateMdState
Var FileContextState
Var FolderContextState
!endif

!define MP_OPTIONS_KEY "Software\Inkase\Installer"
!define MP_MDX_EXT "Software\Classes\.mdx"
!define MP_MD_EXT "Software\Classes\.md"
!define MP_MDX_PROGID "Software\Classes\Inkase.mdx"
!define MP_MD_PROGID "Software\Classes\Inkase.md"
!define MP_MDX_MENU "Software\Classes\SystemFileAssociations\.mdx\shell\InkaseOpen"
!define MP_MD_MENU "Software\Classes\SystemFileAssociations\.md\shell\InkaseOpen"
!define MP_FOLDER_MENU "Software\Classes\Directory\shell\InkaseOpenFolder"

!ifndef BUILD_UNINSTALLER
Function InkaseLoadOptions
  StrCpy $AssociateMdxState 1
  StrCpy $AssociateMdState 0
  StrCpy $FileContextState 1
  StrCpy $FolderContextState 0
  ClearErrors
  ReadRegDWORD $0 SHCTX ${MP_OPTIONS_KEY} AssociateMdx
  ${IfNot} ${Errors}
    StrCpy $AssociateMdxState $0
  ${EndIf}
  ClearErrors
  ReadRegDWORD $0 SHCTX ${MP_OPTIONS_KEY} AssociateMd
  ${IfNot} ${Errors}
    StrCpy $AssociateMdState $0
  ${EndIf}
  ClearErrors
  ReadRegDWORD $0 SHCTX ${MP_OPTIONS_KEY} FileContextMenu
  ${IfNot} ${Errors}
    StrCpy $FileContextState $0
  ${EndIf}
  ClearErrors
  ReadRegDWORD $0 SHCTX ${MP_OPTIONS_KEY} FolderContextMenu
  ${IfNot} ${Errors}
    StrCpy $FolderContextState $0
  ${EndIf}
FunctionEnd

Function InkaseOptionsCreate
  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0 0 100% 12u "文件关联"
  Pop $0
  ${NSD_CreateCheckbox} 8u 18u 100% 12u "关联 .mdx 文件"
  Pop $AssociateMdxCheckbox
  ${NSD_CreateCheckbox} 8u 34u 100% 12u "关联 .md 文件"
  Pop $AssociateMdCheckbox
  ${NSD_CreateLabel} 0 56u 100% 12u "资源管理器右键菜单"
  Pop $0
  ${NSD_CreateCheckbox} 8u 74u 100% 12u "在 .mdx 和 .md 文件右键菜单中添加“使用 Inkase 打开”"
  Pop $FileContextCheckbox
  ${NSD_CreateCheckbox} 8u 90u 100% 12u "在文件夹右键菜单中添加“使用 Inkase 打开文件夹”"
  Pop $FolderContextCheckbox

  ${If} $AssociateMdxState == 1
    ${NSD_Check} $AssociateMdxCheckbox
  ${EndIf}
  ${If} $AssociateMdState == 1
    ${NSD_Check} $AssociateMdCheckbox
  ${EndIf}
  ${If} $FileContextState == 1
    ${NSD_Check} $FileContextCheckbox
  ${EndIf}
  ${If} $FolderContextState == 1
    ${NSD_Check} $FolderContextCheckbox
  ${EndIf}
  nsDialogs::Show
FunctionEnd

Function InkaseOptionsLeave
  ${NSD_GetState} $AssociateMdxCheckbox $AssociateMdxState
  ${NSD_GetState} $AssociateMdCheckbox $AssociateMdState
  ${NSD_GetState} $FileContextCheckbox $FileContextState
  ${NSD_GetState} $FolderContextCheckbox $FolderContextState
  WriteRegDWORD SHCTX ${MP_OPTIONS_KEY} AssociateMdx $AssociateMdxState
  WriteRegDWORD SHCTX ${MP_OPTIONS_KEY} AssociateMd $AssociateMdState
  WriteRegDWORD SHCTX ${MP_OPTIONS_KEY} FileContextMenu $FileContextState
  WriteRegDWORD SHCTX ${MP_OPTIONS_KEY} FolderContextMenu $FolderContextState
FunctionEnd
!endif

!macro InkaseWriteFileAssociation extension progid description
  WriteRegStr SHCTX "Software\Classes\${extension}" "" "${progid}"
  WriteRegStr SHCTX "Software\Classes\${progid}" "" "${description}"
  WriteRegStr SHCTX "Software\Classes\${progid}\DefaultIcon" "" "$appExe,0"
  WriteRegStr SHCTX "Software\Classes\${progid}\shell\open\command" "" '"$appExe" "%1"'
!macroend

!macro InkaseRemoveFileAssociation extension progid
  ReadRegStr $0 SHCTX "Software\Classes\${extension}" ""
  ${If} $0 == "${progid}"
    DeleteRegValue SHCTX "Software\Classes\${extension}" ""
  ${EndIf}
  DeleteRegKey SHCTX "Software\Classes\${progid}"
!macroend

!macro InkaseRestoreFileAssociation extension progid backupName
  ReadRegStr $0 SHCTX "Software\Classes\${extension}" ""
  ${If} $0 == "${progid}"
    ReadRegStr $1 SHCTX ${MP_OPTIONS_KEY} ${backupName}
    ${If} $1 == ""
      DeleteRegValue SHCTX "Software\Classes\${extension}" ""
    ${Else}
      WriteRegStr SHCTX "Software\Classes\${extension}" "" $1
    ${EndIf}
  ${EndIf}
  DeleteRegKey SHCTX "Software\Classes\${progid}"
!macroend

!macro InkaseWriteFileMenu extension
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\${extension}\shell\InkaseOpen" "MUIVerb" "使用 Inkase 打开"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\${extension}\shell\InkaseOpen" "Icon" "$appExe"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\${extension}\shell\InkaseOpen\command" "" '"$appExe" "%1"'
!macroend

!macro InkaseRemoveFileMenu extension
  DeleteRegKey SHCTX "Software\Classes\SystemFileAssociations\${extension}\shell\InkaseOpen"
!macroend

!ifndef BUILD_UNINSTALLER
!macro customInit
  Call InkaseLoadOptions
!macroend

!macro customPageAfterChangeDir
  Page custom InkaseOptionsCreate InkaseOptionsLeave
!macroend
!endif

!macro customInstall
  WriteRegDWORD SHCTX ${MP_OPTIONS_KEY} AssociateMdx $AssociateMdxState
  WriteRegDWORD SHCTX ${MP_OPTIONS_KEY} AssociateMd $AssociateMdState
  WriteRegDWORD SHCTX ${MP_OPTIONS_KEY} FileContextMenu $FileContextState
  WriteRegDWORD SHCTX ${MP_OPTIONS_KEY} FolderContextMenu $FolderContextState
  StrCpy $0 0
  ReadRegDWORD $0 SHCTX ${MP_OPTIONS_KEY} PreviousMdxCaptured
  ${If} $0 != 1
    ReadRegStr $0 SHCTX ${MP_MDX_EXT} ""
    WriteRegStr SHCTX ${MP_OPTIONS_KEY} PreviousMdxAssociation $0
    WriteRegDWORD SHCTX ${MP_OPTIONS_KEY} PreviousMdxCaptured 1
  ${EndIf}
  StrCpy $0 0
  ReadRegDWORD $0 SHCTX ${MP_OPTIONS_KEY} PreviousMdCaptured
  ${If} $0 != 1
    ReadRegStr $0 SHCTX ${MP_MD_EXT} ""
    WriteRegStr SHCTX ${MP_OPTIONS_KEY} PreviousMdAssociation $0
    WriteRegDWORD SHCTX ${MP_OPTIONS_KEY} PreviousMdCaptured 1
  ${EndIf}

  ${If} $AssociateMdxState == 1
    !insertmacro InkaseWriteFileAssociation ".mdx" "Inkase.mdx" "Inkase document"
  ${Else}
    !insertmacro InkaseRestoreFileAssociation ".mdx" "Inkase.mdx" PreviousMdxAssociation
  ${EndIf}
  ${If} $AssociateMdState == 1
    !insertmacro InkaseWriteFileAssociation ".md" "Inkase.md" "Markdown document"
  ${Else}
    !insertmacro InkaseRestoreFileAssociation ".md" "Inkase.md" PreviousMdAssociation
  ${EndIf}
  ${If} $FileContextState == 1
    !insertmacro InkaseWriteFileMenu ".mdx"
    !insertmacro InkaseWriteFileMenu ".md"
  ${Else}
    !insertmacro InkaseRemoveFileMenu ".mdx"
    !insertmacro InkaseRemoveFileMenu ".md"
  ${EndIf}
  ${If} $FolderContextState == 1
    WriteRegStr SHCTX ${MP_FOLDER_MENU} "MUIVerb" "使用 Inkase 打开文件夹"
    WriteRegStr SHCTX ${MP_FOLDER_MENU} "Icon" "$appExe"
    WriteRegStr SHCTX "${MP_FOLDER_MENU}\command" "" '"$appExe" "%1"'
  ${Else}
    DeleteRegKey SHCTX ${MP_FOLDER_MENU}
  ${EndIf}
  System::Call 'shell32::SHChangeNotify(i, i, p, p)' 0x08000000 0 0 0
!macroend

!macro customUnInstall
  !insertmacro InkaseRestoreFileAssociation ".mdx" "Inkase.mdx" PreviousMdxAssociation
  !insertmacro InkaseRestoreFileAssociation ".md" "Inkase.md" PreviousMdAssociation
  !insertmacro InkaseRemoveFileMenu ".mdx"
  !insertmacro InkaseRemoveFileMenu ".md"
  DeleteRegKey SHCTX ${MP_FOLDER_MENU}
  DeleteRegKey SHCTX ${MP_OPTIONS_KEY}
  System::Call 'shell32::SHChangeNotify(i, i, p, p)' 0x08000000 0 0 0
!macroend
