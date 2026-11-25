// Its own class so the manifest merger cannot confuse this provider with any
// other library's androidx FileProvider. Declared in this module's manifest.
package dev.bismark.twitwa.out

import androidx.core.content.FileProvider

class TwitwaOutProvider : FileProvider()
