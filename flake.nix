{
  description = "Speckl — behavioral specification compiler";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in {
        # The speckl compiler as a Nix package
        packages.default = pkgs.stdenv.mkDerivation {
          name = "speckl";
          src = ./compiler;

          buildInputs = with pkgs; [ nodejs nodePackages.npm ];

          buildPhase = ''
            export HOME=$TMP
            npm ci --silent || npm install --silent
            npm run build --silent
          '';

          installPhase = ''
            mkdir -p $out/bin $out/lib/speckl
            cp -r dist/* $out/lib/speckl/
            cp -r node_modules $out/lib/speckl/node_modules

            cat > $out/bin/speckl <<'SCRIPT'
            #!/bin/sh
            exec ${pkgs.nodejs}/bin/node $out/lib/speckl/index.js "$@"
            SCRIPT
            chmod +x $out/bin/speckl
          '';
        };

        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [ nodejs nodePackages.npm ];
        };
      });
}
