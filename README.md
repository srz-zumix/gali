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

For group visibility checks with ADC, include the Cloud Identity Groups read-only scope:

```sh
gcloud auth application-default login --scopes="https://www.googleapis.com/auth/cloud-platform,https://www.googleapis.com/auth/calendar.readonly,https://www.googleapis.com/auth/admin.directory.resource.calendar.readonly,https://www.googleapis.com/auth/cloud-identity.groups.readonly"
```

```sh
gcloud auth application-default set-quota-project <your-quota-project>
```

## Check calendar visibility

`gali check-visibility` checks the authenticated account's effective access role on each
specified calendar without creating or changing events. `reader`, `writerWithoutPrivateAccess`,
`writer`, and `owner` can read details of events whose visibility is `default`; `freeBusyReader`
and `none` cannot. A denied or failed request, or an unknown role, is reported as undetermined.

```sh
gali check-visibility \
  --attendee alice@example.com \
  --group team@example.com \
  --format json
```

Use `--attendee` for an individual and `--group` for a Google Workspace group; either option
can be repeated. Group membership is read recursively through the Cloud Identity Groups API,
which must be enabled and accessible to the authenticated account. Group checks use a separate
OAuth token cache and may authenticate as a different Google account than individual-only
checks. When using OAuth credentials, authorize the requested scopes when prompted; with ADC,
re-authenticate with the Cloud Identity Groups read-only scope as shown above.

The email supplied is used as the calendar ID. Google says a primary calendar ID usually matches
the user's primary email, but this is not guaranteed; aliases and account identity are not
resolved. A result describes only the authenticated account's effective role on that calendar.
It does not establish that the calendar is public, that a particular event exists or is visible,
or how an event with `private` visibility behaves. Incomplete groups and undetermined calendars
are included in the output, and cause a non-zero exit status. JSON output always includes
`visible`, `not_visible`, `undetermined`, and `unresolved_groups` arrays.

Use `--role` to show only results with the specified access roles. Repeat the flag to match
any of them, for example `--role reader --role writer`. Values are case-sensitive:
`none`, `freeBusyReader`, `reader`, `writerWithoutPrivateAccess`, `writer`, and `owner`.
Use `--exclude-role` to omit roles, for example `--exclude-role none --exclude-role freeBusyReader`.
Both flags can be combined, but specifying the same role in both is an error.
The filters apply only to the output: all targets are still checked, and undetermined calendars
and unresolved groups are always reported and still cause a non-zero exit status.

## Copilot canvas

```sh
gali copilot extension install
```

既定ではユーザー領域にインストールします。`--scope repo` でリポジトリ領域、
`--prefix <directory>` で任意のディレクトリを指定できます。
`gali copilot extension update` で更新、`gali copilot extension uninstall` で削除できます。

GitHub Copilot app で他ユーザーの予定を週表示し、メンバーのプリセットを保存できるキャンバス拡張を同梱しています。詳細は
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
