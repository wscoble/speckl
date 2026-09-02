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
        packages.default = pkgs.buildNpmPackage {
          pname = "speckl";
          version = "0.3.1";

          src = pkgs.lib.cleanSource ./compiler;

          npmDepsHash = "sha256-bX7P63cRqaUZPobuT3Cz8WlmDQuVKxdh+rJDBJ2qXcE="; # will be computed on first build

          buildPhase = ''
            npm run build --silent
          '';

          installPhase = ''
            mkdir -p $out/bin $out/lib/speckl
            cp -r dist/* $out/lib/speckl/
            cp -r node_modules $out/lib/speckl/node_modules

            cat > $out/bin/speckl <<'SCRIPT'
            #!/bin/sh
            exec ${pkgs.nodejs}/bin/node ${pkgs.lib.escapeShellArg "$out"}/lib/speckl/index.js "$@"
            SCRIPT
            chmod +x $out/bin/speckl
          '';

          meta = with pkgs.lib; {
            description = "Behavioral specification compiler";
            license = licenses.mit;
          };
        };

        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [ nodejs ];
        };
      });
}
