//  "Villager" - A 24x24 pixel avatar index for the DERO ecosystem

Function Initialize() Uint64
10 IF EXISTS("owner") THEN GOTO 99
20 STORE("owner", ADDRESS_STRING(SIGNER()))
30 STORE("population", 0)
40 STORE("nameHdr", "Villager avatar storage index")
41 STORE("descrHdr", "24x24 pixel avatar storage index")
42 STORE("typeHdr", "Index")
43 STORE("iconURLHdr", "")
44 STORE("tagsHdr", "Villager, Avatar, Social")
50 STORE("devAddr", ADDRESS_RAW("dero1qyqqtsvggrfxtsz6p3yn49n26k83nnr50jmpnyqylykzju4wgl9yvqqdxdvse"))
60 STORE("devFee", 10000)
98 RETURN 0
99 RETURN 1
End Function

Function RegisterAccount() Uint64
10 DIM s as String
20 LET s = ADDRESS_STRING(SIGNER())
30 IF EXISTS("registered_" + s) THEN GOTO 99
40 STORE("registered_" + s, 1)
50 STORE("population", LOAD("population") + 1)
98 RETURN 0
99 RETURN 1
End Function

Function UnRegisterAccount() Uint64
10 DIM s as String
20 LET s = ADDRESS_STRING(SIGNER())
30 IF EXISTS("registered_" + s) THEN GOTO 40 ELSE GOTO 99
40 DELETE("registered_" + s)
50 IF EXISTS("avatar_" + s) THEN GOTO 60 ELSE GOTO 70
60 DELETE("avatar_" + s)
65 DELETE("timestamp_" + s)
70 IF LOAD("population") > 0 THEN GOTO 75 ELSE GOTO 98
75 STORE("population", LOAD("population") - 1)
98 RETURN 0
99 RETURN 1
End Function

Function StoreAvatar(avatar String) Uint64
10 DIM s as String
20 LET s = ADDRESS_STRING(SIGNER())
30 IF EXISTS("registered_" + s) THEN GOTO 60 ELSE GOTO 99
60 IF STRLEN(avatar) == 576 THEN GOTO 65 ELSE GOTO 99
65 IF DEROVALUE() > 0 THEN GOTO 70 ELSE GOTO 80
70 SEND_DERO_TO_ADDRESS(LOAD("devAddr"), DEROVALUE())
80 STORE("avatar_" + s, avatar)
85 STORE("timestamp_" + s, ITOA(BLOCK_HEIGHT()))
98 RETURN 0
99 RETURN 1
End Function

Function UpdateDevFee(newFee Uint64) Uint64
10 IF ADDRESS_STRING(SIGNER()) == LOAD("owner") THEN GOTO 30 ELSE GOTO 99
30 STORE("devFee", newFee)
98 RETURN 0
99 RETURN 1
End Function

/*
This smart contract allows any user account to register once and store or re-store exactly one 576-byte string
that encodes a 24x24 pixel avatar in a publicly accessible index.

The 576-character avatar string defines a 24×24 pixel grid using column-major order.
That is, it fills entire columns from top to bottom, moving left to right.
Each character in the string represents one "pixel" block, specifying both its position on the grid
and its color (using the allowed 62 characters: a–z, A–Z, 0–9).
DVM does not validate the characters themselves, validation must be performed off-chain by dApps that support the stored data.

"devFee" is an optional donation and is handled by Villager frontend, not enforced by the index SC.
It is stored here as a suggestion for the Villager frontend, not an SC requirement.
Intent is to use donated funds collected via usage of the Villager frontend to further support community developers.
devFee suggested value can be reduced or increased by SC owner to suit current environment but will never be enforced by the SC.
Users can freely store Villager avatars by calling the function directly outside of the Villager frontend.

Villager backdrops (frames and backgrounds) are generated deterministically based on the user's DERO address.
The rendering algorithm uses a hash of the address (excluding the "dero1" prefix) to seed various visual elements:
- Background gradients: 4 possible styles (radial, linear, radial offset, conical) with randomized colors and positions.
- Frame styles: 5 unique frame types (polygon shards, starburst spikes, glitch rings, crystal grid, nebula rings) with glow effects.
- Tiny starfield: Randomly placed stars for added texture.
This ensures each Villager has a unique, address-derived backdrop that enhances the avatar without requiring additional storage.
This approach achieves both user-directed avatars (the 24x24 pixel grid that users can customize) and a non-changeable visual indication of identity (the deterministic backdrop tied to the address), covering the combined use case as identicons.

Here’s how the positions map:
Position 1 → Grid cell A1 (top-left)  
Position 24 → Grid cell A24 (bottom of column A)  
Position 25 → Grid cell B1 (top of column B)  
Position 48 → Grid cell B24  
...
Position 553 → Grid cell X1  
Position 576 → Grid cell X24 (bottom-right)

Supported colors ordered by hue then shades:
Color.0 0xFFFF9999
Color.1 0xFFFF6666
Color.2 0xFFFF0000
Color.3 0xFF800000
Color.4 0xFFFFA899
Color.5 0xFFFF8C66
Color.6 0xFFFF4500
Color.7 0xFF802200
Color.8 0xFFFFC799
Color.9 0xFFFFB266
Color.A 0xFFFF8C00
Color.B 0xFF804600
Color.C 0xFFFFE099
Color.D 0xFFFFD866
Color.E 0xFFFFAA00
Color.F 0xFF5C4033
Color.G 0xFFFFFF99
Color.H 0xFFFFFF66
Color.I 0xFFFFFF00
Color.J 0xFFFFD700
Color.K 0xFFCFFF99
Color.L 0xFFBFFF66
Color.M 0xFF80FF00
Color.N 0xFF408000
Color.O 0xFF99FF99
Color.P 0xFF66FF66
Color.Q 0xFF00FF00
Color.R 0xFF008000
Color.S 0xFF99FFCF
Color.T 0xFF66FFBF
Color.U 0xFF00FF80
Color.V 0xFF008040
Color.W 0xFF99FFFF
Color.X 0xFF66FFFF
Color.Y 0xFF00FFFF
Color.Z 0xFF008080
Color.a 0xFF99CFFF
Color.b 0xFF66BFFF
Color.c 0xFF0080FF
Color.d 0xFF004080
Color.e 0xFF9999FF
Color.f 0xFF6666FF
Color.g 0xFF0000FF
Color.h 0xFF000080
Color.i 0xFFCF99FF
Color.j 0xFFBF66FF
Color.k 0xFF8000FF
Color.l 0xFF400080
Color.m 0xFFFF99FF
Color.n 0xFFFF66FF
Color.o 0xFFFF00FF
Color.p 0xFF800080
Color.q 0xFFFF99C7
Color.r 0xFFFF66B2
Color.s 0xFFFF0080
Color.t 0xFF800040
Color.u 0xFFFFFFFF
Color.v 0xFFB4B4B4
Color.w 0xFF848484
Color.x 0xFF434343
Color.y 0xFF000000
Color.z 0x00000000
*/