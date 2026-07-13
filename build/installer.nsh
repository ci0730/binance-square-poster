!macro customInstall
  CreateDirectory "$INSTDIR\data"
  CreateDirectory "$INSTDIR\data\uploads"
  FileOpen $0 "$INSTDIR\data\说明.txt" w
  FileWrite $0 "此目录用于保存软件配置与缓存数据。$\r$\n"
  FileWrite $0 "包括：账号配置、AI 设置、代理、已发布帖子缓存、上传图片等。$\r$\n"
  FileWrite $0 "卸载软件时不会自动删除此目录，方便您保留数据。$\r$\n"
  FileClose $0
!macroend
