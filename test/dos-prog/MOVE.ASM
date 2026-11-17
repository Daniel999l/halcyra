; MOVE.COM - a tiny DOS test program for the in-tab console (written for this
; project, no game data). Mode 13h (320x200). A yellow 16x16 square moves while
; the arrow keys are held (2 px per screen refresh); six boxes along the bottom
; light green while their key is down: Up, Down, Left, Right, Enter, Space.
; Esc quits. Build: nasm -f bin -o MOVE.COM MOVE.ASM
org 100h

start:
        mov ax, 13h
        int 10h
        mov ax, 3509h           ; old keyboard interrupt -> es:bx
        int 21h
        mov [old9], bx
        mov [old9+2], es
        mov dx, kbd
        mov ax, 2509h           ; ds:dx = our handler
        int 21h
        push word 0A000h
        pop es
        cld
        ; a grey bar along the top, so the picture is never flat
        xor di, di
        mov al, 7
        mov cx, 320*4
        rep stosb

main:
        call vsync
        mov al, 0
        call drawsq             ; erase at the old place
        cmp byte [keys+48h], 0  ; up
        je .n1
        cmp word [py], 6
        jb .n1
        sub word [py], 2
.n1:    cmp byte [keys+50h], 0  ; down
        je .n2
        cmp word [py], 152
        ja .n2
        add word [py], 2
.n2:    cmp byte [keys+4Bh], 0  ; left
        je .n3
        cmp word [px], 2
        jb .n3
        sub word [px], 2
.n3:    cmp byte [keys+4Dh], 0  ; right
        je .n4
        cmp word [px], 302
        ja .n4
        add word [px], 2
.n4:    mov al, 14
        call drawsq
        call drawkeys
        cmp byte [keys+01h], 0  ; esc
        je main

        push ds
        lds dx, [old9]
        mov ax, 2509h
        int 21h
        pop ds
        mov ax, 3
        int 10h
        mov ax, 4C00h
        int 21h

; keyboard interrupt: keep a table of which scan codes are down
kbd:
        push ax
        push bx
        in al, 60h
        cmp al, 0E0h            ; extended prefix: the next byte says which key
        je .done
        mov bl, al
        and bl, 7Fh
        xor bh, bh
        test al, 80h
        jnz .up
        mov byte [cs:keys+bx], 1
        jmp .done
.up:    mov byte [cs:keys+bx], 0
.done:  mov al, 20h
        out 20h, al
        pop bx
        pop ax
        iret

vsync:
        mov dx, 3DAh
.a:     in al, dx
        test al, 8
        jnz .a
.b:     in al, dx
        test al, 8
        jz .b
        ret

; al = colour; the 16x16 square at (px, py)
drawsq:
        push ax
        mov ax, [py]
        mov bx, 320
        mul bx
        add ax, [px]
        mov di, ax
        pop ax
        mov dx, 16
.r:     mov cx, 16
        rep stosb
        add di, 320-16
        dec dx
        jnz .r
        ret

drawkeys:
        xor si, si
.k:     mov bl, [ktab+si]
        xor bh, bh
        mov al, 8
        cmp byte [keys+bx], 0
        je .c
        mov al, 10
.c:     push ax
        mov ax, si
        mov cx, 50
        mul cx
        add ax, 176*320+20
        mov di, ax
        pop ax
        mov dx, 16
.r:     mov cx, 40
        rep stosb
        add di, 320-40
        dec dx
        jnz .r
        inc si
        cmp si, 6
        jb .k
        ret

px:     dw 152
py:     dw 80
old9:   dd 0
ktab:   db 48h, 50h, 4Bh, 4Dh, 1Ch, 39h
keys:   times 128 db 0
