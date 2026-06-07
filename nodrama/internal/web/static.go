package web

import (
	"embed"
	"io/fs"
	"net/http"
)

//go:embed static/*
var staticFiles embed.FS

func StaticHandler() http.Handler {
	sub, err := fs.Sub(staticFiles, "static")
	if err != nil {
		panic(err)
	}
	return http.FileServer(http.FS(sub))
}

func ServeIndex(w http.ResponseWriter, r *http.Request) {
	http.ServeFileFS(w, r, staticFiles, "static/index.html")
}
