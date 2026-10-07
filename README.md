# gali

Google cAlender cLI

## Install

```sh
brew install srz-zumix/tap/gali
```

## SetUp

```sh
gcloud auth application-default login --scopes="https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/calendar.readonly,https://www.googleapis.com/auth/admin.directory.resource.calendar.readonly"
```

```sh
gcloud auth application-default set-quota-project <your-quota-project>
```

## Copilot canvas

```sh
gali copilot extension install
```

既定ではユーザー領域にインストールします。`--scope repo` でリポジトリ領域、
`--prefix <directory>` で任意のディレクトリを指定できます。
`gali copilot extension update` で更新、`gali copilot extension uninstall` で削除できます。

GitHub Copilot app で他ユーザーの予定を週表示するキャンバス拡張を同梱しています。詳細は
[.github/extensions/gali/README.md](.github/extensions/gali/README.md) を参照してください。

## Completion sources

非公開予定を参照カレンダーで補完すると、JSON 出力の
`items[].extendedProperties.private["gali.completedFrom"]` に実際に使用した参照カレンダー ID が入ります。
カレンダー名が取得できた場合は `gali.completedFromName` に名前も入ります。
`primary`（`me` / `@me`）は実際のカレンダー ID に解決されます。複数の参照に同じ予定がある場合、
選ばれたタイトル付きのコピーの出自を記録します。補完しなかった予定には追加しません。

```sh
gali events teammate@example.com --ref reference@example.com --format json
```

```json
{
  "extendedProperties": {
    "private": {
      "gali.completedFrom": "reference@example.com",
      "gali.completedFromName": "Reference Calendar"
    }
  }
}
```

テキスト出力は、表示対象に補完予定があるときだけ `COMPLETED_FROM_NAME` 列を追加し、
名前を優先して表示します。TUI の予定詳細でも名前を優先し、ID も確認できます。
名前が取得できない場合は ID を表示します。これは出力専用のメタデータで、Google Calendar には書き込みません。
